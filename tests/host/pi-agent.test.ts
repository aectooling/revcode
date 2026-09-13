import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAgent } from '../../src/host/pi-agent.js';

it.each(['revit_execute_csharp', 'custom_capture'])('real Pi SDK advertises both tools and consumes %s results through a local model fixture', async scenario => {
  const toolName = scenario === 'custom_capture' ? 'revit_capture_view' : scenario;
  const dir = await mkdtemp(join(tmpdir(), 'revcode-pi-'));
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'revcode-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (requests.length === 1) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: toolName, arguments: JSON.stringify(toolName === 'revit_capture_view' ? { viewId: 'view-1', documentToken: 'doc' } : { code: 'return 7;', mode: 'query' }) } }] });
      chunk({}, 'tool_calls');
    } else { chunk({ role: 'assistant', content: 'There are 7 levels.' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    let agent = await createPiAgent(dir, dir, runtime => runtime.registerProvider('openai', {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-key',
      models: [{ id: 'revcode-fixture', name: 'Fixture', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    }));
    if (scenario === 'custom_capture') {
      await agent.addProvider!({ id: 'custom-vision', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-key',
        models: [{ id: 'revcode-fixture', supportsImages: true }] });
      agent = await createPiAgent(dir); // Reload persisted capabilities through the real SDK.
    }
    let output = ''; let calls = 0;
    await agent.prompt('Count levels', { provider: scenario === 'custom_capture' ? 'custom-vision' : 'openai', model: 'revcode-fixture', configured: true }, {
      instanceId: 'fixture', revitVersion: '2026', revitBuild: '26.3', runtime: '.NET 8', document: { token: 'doc', title: 'Test', isFamily: false, isReadOnly: false, activeView: 'Level 1', selection: [] },
    }, [], async input => { calls++;
      if (toolName === 'revit_capture_view') {
        expect(input).toMatchObject({ mode: 'api', documentToken: 'doc' });
        const file = input.code.match(/FilePath = @"([^"]+)"/)![1];
        await writeFile(file + '.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64'));
      } else expect(input).toEqual({ code: 'return 7;', mode: 'query' }); return { ...input, operationId: 'op', documentToken: 'doc', createdAt: new Date().toISOString(), status: 'succeeded', result: 7 }; }, value => { output = value; });
    expect(calls).toBe(1); expect(output).toContain('There are 7 levels.');
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['revit_execute_csharp', 'revit_capture_view']);
    if (toolName === 'revit_capture_view') {
      expect(JSON.stringify(requests[1].messages)).toContain('data:image/png;base64,');
      expect(await readdir(join(dir, 'captures'))).toEqual([]);
    }
    expect(requests[1].messages.some((message: any) => message.role === 'tool' && message.content.includes('"result":7'))).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}, 30000);

it('persists custom providers and reuses shared SDK credentials across hosts with logout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revcode-auth-'));
  const user = join(dir, 'user'); const authPath = join(dir, 'shared-pi-auth.json');
  try {
    const first = await createPiAgent(join(dir, 'instance-a'), user, undefined, authPath);
    expect(first.providers.length).toBeGreaterThan(3);
    expect(first.providers.some(p => p.authMethods?.some(m => m.type === 'oauth'))).toBe(true);
    await first.addProvider!({ id: 'custom-fixture', name: 'Fixture endpoint', baseUrl: 'http://localhost:9999/v1', apiKey: 'test-private-key', models: [{ id: 'fixture-model' }] });
    expect(first.providers.find(p => p.id === 'custom-fixture')).toMatchObject({ authenticated: true, name: 'Fixture endpoint', canLogout: true });
    expect(await readFile(join(user, 'models.json'), 'utf8')).not.toContain('test-private-key');
    const second = await createPiAgent(join(dir, 'instance-b'), user, undefined, authPath);
    expect(second.configured('custom-fixture')).toBe(true);
    expect(second.providers.find(p => p.id === 'custom-fixture')?.models[0].id).toBe('fixture-model');
    await second.logout!('custom-fixture'); await first.refresh!();
    expect(first.configured('custom-fixture')).toBe(false);
    await first.addProvider!({ id: 'custom-keyless', baseUrl: 'http://localhost:9998/v1', models: [{ id: 'local-model' }] });
    expect(first.configured('custom-keyless')).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);

it('uses real SDK OAuth login interaction and credential persistence with a simulated provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revcode-oauth-'));
  try {
    const agent = await createPiAgent(dir, dir, runtime => runtime.registerProvider('fixture-oauth', {
      oauth: { name: 'Fixture subscription',
        login: async callbacks => {
          callbacks.onAuth({ url: 'https://example.test/sign-in', instructions: 'Complete sign-in.' });
          expect(await callbacks.onPrompt({ message: 'Authorization code' })).toBe('fixture-code');
          return { access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 };
        },
        refreshToken: async value => value, getApiKey: value => value.access,
      },
      api: 'openai-completions', baseUrl: 'http://localhost:9999/v1', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    }));
    const notifications: unknown[] = [];
    await agent.login!('fixture-oauth', 'oauth', { prompt: async prompt => { expect(prompt.message).toBe('Authorization code'); return 'fixture-code'; }, notify: event => notifications.push(event) });
    expect(notifications).toContainEqual({ type: 'auth_url', url: 'https://example.test/sign-in', instructions: 'Complete sign-in.' });
    expect(agent.configured('fixture-oauth')).toBe(true);
    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'));
    expect(stored['fixture-oauth']).toMatchObject({ type: 'oauth', access: 'fixture-access' });
    expect(JSON.stringify(agent.providers)).not.toContain('fixture-access');
    await agent.logout!('fixture-oauth'); expect(agent.configured('fixture-oauth')).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);
