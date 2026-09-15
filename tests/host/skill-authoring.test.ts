import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../../src/host/server.js';
import { createSkillTools, type RunServices } from '../../src/host/skills.js';
import type { Agent } from '../../src/host/types.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('persists host-selected source provenance through authenticated authoring while Revit is disconnected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revcode-authoring-integration-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let acceptedServices: RunServices | undefined;
  let savedId: string | undefined;
  const agent: Agent = {
    providers: [{ id: 'anthropic', models: [{ id: 'fixture', name: 'Fixture' }] }], configured: () => true,
    setKey: async () => {}, abort: async () => {},
    prompt: async (text, _settings, _context, _history, _execute, update, _desktop, services) => {
      acceptedServices = services;
      if (text === 'Create the reusable procedure') {
        const save = createSkillTools(services!).find(t => t.name === 'skill_save')!;
        const result = await (save.execute as any)('save-fixture', { root: services!.skills!.library.folder, expectedPreferencesRevision: services!.skills!.library.revision, files: { 'procedure/SKILL.md': '# Procedure\nRecorded evidence is incomplete; verify before reuse.' }, sourceRuns: [{ instanceId: 'untrusted-model', runId: 'invented' }] });
        savedId = result.details.id;
      }
      update('Done.');
    },
  };
  const host = await createHost({ instanceId: 'authoring-host', nativeToken: 'native-token', dataDir: dir, webDir: dir, agent });
  cleanups.push(() => host.close());
  const api = (path: string, data?: unknown) => fetch(`${host.url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${host.browserToken}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  expect(host.snapshot().connected).toBe(false);
  const source = await (await api('chat', { requestId: 'source-authoring-run', mode: 'authoring', text: 'Explain a procedure with incomplete evidence' })).json();
  await expect.poll(() => host.snapshot().chatBusy).toBe(false);
  const response = await api('chat', { requestId: 'extract-authoring-run', mode: 'authoring', text: 'Create the reusable procedure', sourceRunIds: [source.runId] });
  expect(response.status).toBe(202);
  await expect.poll(() => host.snapshot().chatBusy).toBe(false);
  expect(savedId).toBeTruthy();
  expect(acceptedServices?.sourceRunReferences).toEqual([{ instanceId: 'authoring-host', runId: source.runId, number: 1 }]);
  const revisions = await (await api(`skills/${encodeURIComponent(savedId!)}/revisions`)).json();
  expect(revisions.revisions.at(-1).sourceRuns).toEqual([{ instanceId: 'authoring-host', runId: source.runId, number: 1 }]);
});
