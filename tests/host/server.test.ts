import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dealer } from 'zeromq';
import { createHost } from '../../src/host/server.js';
import type { Agent } from '../../src/host/types.js';

const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });
const context = { instanceId: 'test-instance', revitVersion: '2026', revitBuild: '26.3', runtime: '.NET 8', document: { token: 'doc-1', title: 'Test', isFamily: false, isReadOnly: false, activeView: 'Level 1', selection: [] } };
async function setup(overrides: Partial<Agent> = {}, heartbeatMs = 10000) {
  const dir = await mkdtemp(join(tmpdir(), 'revcode-host-'));
  resources.push(() => rm(dir, { recursive: true, force: true }));
  const agent: Agent = { providers: [{ id: 'anthropic', models: [{ id: 'test-model', name: 'Test' }] }], configured: () => true, setKey: async () => {}, abort: async () => {}, prompt: async () => {}, ...overrides };
  const host = await createHost({ instanceId: 'test-instance', nativeToken: 'native-secret', dataDir: dir, webDir: dir, agent, heartbeatMs });
  resources.push(() => host.close());
  const dealer = new Dealer({ receiveTimeout: 2000, linger: 0 }); dealer.connect(host.nativeEndpoint);
  resources.push(async () => dealer.close());
  const native = async (type: string, payload?: unknown, token = 'native-secret') => dealer.send(JSON.stringify({ type, token, payload }));
  const api = async (path: string, data?: unknown, token = host.browserToken) => fetch(host.url + '/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  await native('context', context);
  await expect.poll(() => host.snapshot().connected).toBe(true);
  return { host, dealer, native, api, dir };
}

describe('authenticated Revit host', () => {
  it('targets a non-active document and preserves the explicit binding in the journal', async () => {
    const { api, native, dealer, host, dir } = await setup();
    const target = { ...context.document, token: 'project-2', title: 'Other project' };
    await native('context', { ...context, documents: [context.document, target] });
    await expect.poll(() => host.snapshot().context?.documents?.length).toBe(2);
    expect((await api('execute', { requestId: 'other-doc-001', code: 'return ctx.Doc.Title;', mode: 'modify', documentToken: target.token })).status).toBe(202);
    const [frame] = await dealer.receive();
    expect(JSON.parse(frame.toString()).command).toMatchObject({ documentToken: target.token, mode: 'modify' });
    expect(JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8')).operations[0].documentToken).toBe(target.token);
  });

  it('rejects stale, invalid and read-only targets without falling back to the active document', async () => {
    const { api, native, host } = await setup();
    await native('context', { ...context, documents: [context.document, { ...context.document, token: 'readonly', isReadOnly: true }] });
    await expect.poll(() => host.snapshot().context?.documents?.length).toBe(2);
    const input = { requestId: 'invalid-doc-01', code: 'return 1;', mode: 'modify' };
    expect((await api('execute', { ...input, documentToken: 'closed' })).status).toBe(409);
    expect((await api('execute', { ...input, documentToken: 'readonly' })).status).toBe(409);
    expect((await api('execute', { ...input, documentToken: 42 })).status).toBe(400);
    expect((await api('execute', { ...input, documentToken: null })).status).toBe(409);
    expect(host.snapshot().operations).toHaveLength(0);
  });

  it.each(['query', 'api'])('allows %s with no active document', async mode => {
    const { api, native, dealer, host } = await setup();
    await native('context', { ...context, document: null, documents: [] });
    await expect.poll(() => host.snapshot().context?.document).toBeNull();
    expect((await api('execute', { requestId: 'no-doc-00001', code: 'return ctx.Documents.Length;', mode })).status).toBe(202);
    const [frame] = await dealer.receive();
    expect(JSON.parse(frame.toString()).command).toMatchObject({ documentToken: null, mode });
  });

  it('rejects browser/native credential confusion and hostile browser origins', async () => {
    const { host, api, native } = await setup();
    expect((await api('state', undefined, 'native-secret')).status).toBe(401);
    const cross = await fetch(host.url + '/api/state', { headers: { Authorization: `Bearer ${host.browserToken}`, Origin: 'https://attacker.example' } });
    expect(cross.status).toBe(403);
    await native('context', { ...context, document: null }, host.browserToken);
    expect((await (await api('state')).json()).context.document.token).toBe('doc-1');
  });

  it('journals before dispatch, returns native results, and deduplicates UI submissions', async () => {
    const { api, dealer, native, dir } = await setup();
    const input = { requestId: 'request-0001', code: 'return 42;', mode: 'query' };
    const response = await api('execute', input); expect(response.status).toBe(202);
    const accepted = await response.json();
    const [frame] = await dealer.receive(); const command = JSON.parse(frame.toString()).command;
    expect(command).toMatchObject({ kind: 'execute', documentToken: 'doc-1', code: 'return 42;', operationId: accepted.operationId });
    const saved = JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8'));
    expect(saved.requests[input.requestId].response.operationId).toBe(command.operationId);
    expect(await (await api('execute', input)).json()).toEqual(accepted);
    expect((await api('execute', { ...input, code: 'return 43;' })).status).toBe(409);
    await native('operation', { operationId: command.operationId, status: 'succeeded', result: 42 });
    await expect.poll(async () => (await (await api('state')).json()).operations[0].status).toBe('succeeded');
    expect((await (await api('state')).json()).operations[0].result).toBe(42);
  });

  it('fences uncertain mutations after disconnect until a native receipt reconciles them', async () => {
    const { api, dealer, native } = await setup();
    await api('execute', { requestId: 'mutation-0001', code: 'return 1;', mode: 'modify' });
    const [frame] = await dealer.receive(); const { command } = JSON.parse(frame.toString());
    await native('disconnect');
    await expect.poll(async () => (await (await api('state')).json()).operations[0].status).toBe('unknown');
    await native('context', context);
    expect((await api('execute', { requestId: 'mutation-0002', code: 'return 2;', mode: 'modify' })).status).toBe(409);
    await native('operation', { operationId: command.operationId, status: 'succeeded', result: 1, transactionStatus: 'Committed' });
    await expect.poll(async () => (await (await api('state')).json()).busy).toBe(false);
    expect((await api('execute', { requestId: 'mutation-0002', code: 'return 2;', mode: 'modify' })).status).toBe(202);
  });

  it('routes an agent tool through the same native executor and persists the answer', async () => {
    let prompts = 0;
    const { api, dealer, native } = await setup({ prompt: async (_text, _settings, _context, _history, execute, update) => {
      prompts++;
      const result = await execute({ code: 'return 3;', mode: 'query' }); update(`Found ${result.result} levels.`);
    } });
    const request = { requestId: 'chat-000001', text: 'How many levels?' };
    expect((await api('chat', request)).status).toBe(202);
    const [frame] = await dealer.receive(); const { command } = JSON.parse(frame.toString());
    await native('operation', { operationId: command.operationId, status: 'succeeded', result: 3 });
    await expect.poll(async () => (await (await api('state')).json()).messages.at(-1).text).toBe('Found 3 levels.');
    expect((await api('chat', request)).status).toBe(202); expect(prompts).toBe(1);
  });

  it('sends cancellation without claiming a running operation is stopped', async () => {
    const { api, dealer } = await setup();
    await api('execute', { requestId: 'cancel-00001', code: 'return 1;', mode: 'modify' });
    const [frame] = await dealer.receive(); const { command } = JSON.parse(frame.toString());
    await api('cancel', {});
    const [cancelFrame] = await dealer.receive(); expect(JSON.parse(cancelFrame.toString()).command).toEqual({ kind: 'cancel', operationId: command.operationId });
    expect((await (await api('state')).json()).busy).toBe(true);
  });

  it('marks interrupted journal records unknown on restart and never replays them', async () => {
    const { host, api, dealer, dir } = await setup();
    const input = { requestId: 'restart-0001', code: 'return 1;', mode: 'modify' };
    const accepted = await (await api('execute', input)).json();
    await dealer.receive();
    await host.close();
    // Avoid closing the original host a second time during cleanup.
    resources.splice(resources.length - 2, 1);
    const restarted = await createHost({ instanceId: 'test-instance', nativeToken: 'new-native-secret', dataDir: dir, webDir: dir,
      agent: { providers: [], configured: () => false, setKey: async () => {}, prompt: async () => {}, abort: async () => {} } });
    resources.push(() => restarted.close());
    expect(restarted.snapshot().operations[0]).toMatchObject({ operationId: accepted.operationId, status: 'unknown' });
    const response = await fetch(restarted.url + '/api/execute', { method: 'POST', headers: { Authorization: `Bearer ${restarted.browserToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    expect(response.status).toBe(202); expect(await response.json()).toEqual(accepted);
    expect(restarted.snapshot().busy).toBe(true);
  });

  it('bridges OAuth URL, prompt response and completion without persisting codes', async () => {
    let signedIn = false;
    const { api, dir } = await setup({
      providers: [{ id: 'fixture-oauth', name: 'Subscription', models: [], authMethods: [{ type: 'oauth', label: 'Sign in' }], canLogout: true }],
      login: async (_provider, type, interaction) => {
        expect(type).toBe('oauth'); interaction.notify({ type: 'auth_url', url: 'https://example.test/oauth', instructions: 'Sign in in your browser.' });
        const code = await interaction.prompt({ type: 'manual_code', message: 'Paste code' });
        expect(code).toBe('test-oauth-code'); signedIn = true;
      }, logout: async () => { signedIn = false; },
    });
    expect((await api('auth/login', { provider: 'fixture-oauth', authType: 'oauth' })).status).toBe(202);
    let state: any;
    await expect.poll(async () => { state = await (await api('state')).json(); return state.auth.request?.prompt; }).toBe('Paste code');
    expect(state.auth.url).toBe('https://example.test/oauth');
    expect((await api('auth/respond', { requestId: 'stale', value: 'bad' })).status).toBe(400);
    expect((await api('auth/respond', { requestId: state.auth.request.requestId, value: 'test-oauth-code' })).status).toBe(200);
    await expect.poll(async () => (await (await api('state')).json()).auth.completedCount).toBe(1);
    expect(signedIn).toBe(true);
    expect(await readFile(join(dir, 'journal.json'), 'utf8')).not.toContain('test-oauth-code');
    expect((await api('auth/logout', { provider: 'fixture-oauth' })).status).toBe(200); expect(signedIn).toBe(false);
  });

  it('cancels a pending provider prompt through the SDK signal', async () => {
    const { api } = await setup({ providers: [{ id: 'fixture', models: [], authMethods: [{ type: 'api_key', label: 'API key' }] }],
      login: async (_provider, _type, interaction) => { await interaction.prompt({ type: 'secret', message: 'API key' }); },
    });
    await api('auth/login', { provider: 'fixture', authType: 'api_key' });
    await expect.poll(async () => (await (await api('state')).json()).auth.request?.password).toBe(true);
    await api('auth/cancel', {});
    await expect.poll(async () => (await (await api('state')).json()).auth.busy).toBe(false);
    expect((await (await api('state')).json()).auth.error).toContain('cancelled');
  });
});
