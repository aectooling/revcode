import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HostSkillLibrary, SKILL_LIMITS } from '../../src/host/skills.js';
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(resolve(tmpdir(), 'revcode-skills-')); temporary.push(dir); const root = resolve(dir, 'library'); const preferences = resolve(dir, 'preferences.json'); const library = new HostSkillLibrary(dir, preferences, root); await library.initialize(); return { dir, root, preferences, library }; }
async function put(root: string, path: string, text: string) { const dest = resolve(root, path); await mkdir(resolve(dest, '..'), { recursive: true }); await writeFile(dest, text); }
describe('skills library', () => {
  it('assigns supporting Markdown/C# to the nearest skill and ignores standalone C#', async () => { const { root, library } = await setup(); await put(root, 'outer/SKILL.md', '# Outer'); await put(root, 'outer/reference.md', 'reference'); await put(root, 'outer/example.cs', 'return 1;'); await put(root, 'outer/inner/SKILL.md', '# Inner'); await put(root, 'outer/inner/ref.md', 'inner reference'); await put(root, 'loose.md', '# Loose'); await put(root, 'loose.cs', 'ignored'); await library.refresh(); const list = library.snapshot(); expect(list.skills).toHaveLength(3); expect(list.skills.find(s => s.name === 'outer')!.files).toEqual(['outer/example.cs', 'outer/reference.md', 'outer/SKILL.md']); expect(list.skills.find(s => s.name === 'inner')!.files).toHaveLength(2); });
  it('keeps run bytes immutable and rejects disabled/stale selections', async () => { const { root, library } = await setup(); await put(root, 'one.md', 'Original'); await library.refresh(); const skill = library.snapshot().skills[0]; const run = await library.createRunSnapshot([skill.id]); await put(root, 'one.md', 'Changed'); await library.update({ type: 'enabled', expectedRevision: 0, id: skill.id, enabled: false }); expect(run.read(skill.id).content).toBe('Original'); await expect(library.createRunSnapshot([skill.id])).rejects.toThrow('disabled or unavailable'); });
  it('detects shared preference conflicts between hosts', async () => { const { dir, root, preferences, library } = await setup(); await put(root, 'one.md', 'One'); await library.refresh(); const other = new HostSkillLibrary(dir, preferences, root); await other.initialize(); const id = library.snapshot().skills[0].id; await library.update({ expectedRevision: 0, type: 'enabled', id, enabled: false }); await expect(other.update({ expectedRevision: 0, type: 'enabled', id, enabled: true })).rejects.toThrow('Conflict'); await other.refresh(); expect(other.snapshot().skills[0].enabled).toBe(false); });
  it('creates, revision-checks, restores the complete prior file set and preserves disabled state', async () => { const { root, library } = await setup(); const first = await library.save({ root, expectedPreferencesRevision: 0, files: { 'new/SKILL.md': '# First' } }); await library.update({ type: 'enabled', expectedRevision: 0, id: first.id, enabled: false }); const second = await library.save({ root, expectedPreferencesRevision: 1, id: first.id, expectedRevision: first.revision, files: { 'new/SKILL.md': '# Second', 'new/example.cs': 'return true;' } }); await expect(library.save({ root, expectedPreferencesRevision: 1, id: first.id, expectedRevision: first.revision, files: { 'new/SKILL.md': 'Stale' } })).rejects.toThrow('Conflict'); await library.restore({ root, id: first.id, expectedPreferencesRevision: 1, expectedRevision: second.revision, revision: first.revision }); expect(library.preview(first.id).files).toEqual({ 'new/SKILL.md': '# First' }); expect(library.preview(first.id).skill.enabled).toBe(false); await expect(readFile(resolve(root, 'new/example.cs'))).rejects.toMatchObject({ code: 'ENOENT' }); });
  it('rejects traversal, unsupported files, case collisions and folder changes', async () => { const { root, library, dir } = await setup(); const save = (files: Record<string, string>) => library.save({ root, expectedPreferencesRevision: 0, files }); await expect(save({ '../escape.md': 'bad' })).rejects.toThrow('Invalid'); await expect(save({ 'a/SKILL.md': 'a', 'a/run.exe': 'bad' })).rejects.toThrow('Invalid'); await expect(save({ 'a/SKILL.md': 'a', 'a/REF.md': 'a', 'a/ref.md': 'b' })).rejects.toThrow('collision'); await mkdir(resolve(dir, 'other')); await library.update({ expectedRevision: 0, type: 'folder', folder: resolve(dir, 'other') }); await expect(save({ 'a.md': 'a' })).rejects.toThrow('Conflict'); });
  it('bounds supported files and ranged context reads', async () => { const { root, library } = await setup(); await put(root, 'huge.md', 'a'.repeat(SKILL_LIMITS.fileBytes + 1)); await put(root, 'read.md', 'a'.repeat(SKILL_LIMITS.readBytes + 10)); await library.refresh(); expect(library.snapshot().diagnostics.join()).toContain('256 KiB'); const run = await library.createRunSnapshot(); const id = library.snapshot().skills[0].id; const first = run.read(id); expect(first.truncated).toBe(true); expect(first.complete).toBe(false); expect(run.read(id, undefined, first.nextOffset).content).toHaveLength(10); });
  it('skips escaping links', async () => { const { root, library, dir } = await setup(); await put(dir, 'outside/SKILL.md', 'outside'); try { await symlink(resolve(dir, 'outside'), resolve(root, 'escape'), 'junction'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return; throw e; } await library.refresh(); expect(library.snapshot().skills).toHaveLength(0); expect(library.snapshot().diagnostics.join()).toContain('Skipped link'); });
});

it('recovers interrupted multi-file saves without overwriting external edits', async () => {
  const { dir, root, library } = await setup();
  await put(root, 'one.md', 'after'); await put(root, 'introduced.cs', 'new');
  const recovery = resolve(dir, 'skill-revisions', 'fixture.pending.json');
  await put(dir, 'skill-revisions/fixture.pending.json', JSON.stringify({ root, before: { 'one.md': 'before' }, after: { 'one.md': 'after', 'introduced.cs': 'new' }, changedFiles: ['one.md', 'introduced.cs'] }));
  await library.recoverPending(); expect(await readFile(resolve(root, 'one.md'), 'utf8')).toBe('before'); await expect(readFile(resolve(root, 'introduced.cs'))).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(recovery)).rejects.toMatchObject({ code: 'ENOENT' });
  await put(dir, 'skill-revisions/fixture.pending.json', JSON.stringify({ root, before: { 'one.md': 'before' }, after: { 'one.md': 'after' }, changedFiles: ['one.md'] }));
  await put(root, 'one.md', 'external edit'); await library.recoverPending(); expect(await readFile(resolve(root, 'one.md'), 'utf8')).toBe('external edit'); await library.refresh(); expect(library.snapshot().diagnostics.join()).toContain('Interrupted skill update'); await expect(library.save({ root, expectedPreferencesRevision: 0, files: { 'new.md': 'new' } })).rejects.toThrow('requires recovery');
});

it('keeps identities distinct across custom libraries and detects external edits', async () => {
  const { dir, root, library } = await setup(); await put(root, 'one.md', 'original'); await library.refresh(); const original = library.snapshot().skills[0];
  await put(root, 'one.md', 'external edit'); await expect(library.save({ root, expectedPreferencesRevision: 0, id: original.id, expectedRevision: original.revision, files: { 'one.md': 'overwrite' } })).rejects.toThrow('Conflict');
  const other = resolve(dir, 'second'); await put(other, 'one.md', 'same name'); await library.update({ type: 'folder', folder: other, expectedRevision: 0 }); expect(library.snapshot().skills[0].id).not.toBe(original.id);
});

it('pins agent authoring to the accepted folder and revision', async () => {
  const { createSkillTools } = await import('../../src/host/skills.js');
  const { root, library, dir } = await setup(); await put(root, 'one.md', 'Original');
  const snapshot = await library.createRunSnapshot();
  const tools = createSkillTools({ mode: 'authoring', library, skills: snapshot });
  const invoke = (name: string, input: unknown) => (tools.find(t => t.name === name)!.execute as any)('call', input);
  const other = resolve(dir, 'new-library'); await mkdir(other); await library.update({ type: 'folder', folder: other, expectedRevision: 0 });
  await expect(invoke('skill_edit_read', { id: snapshot.library.skills[0].id })).rejects.toThrow('after this run started');
  await expect(invoke('skill_save', { root: other, expectedPreferencesRevision: 1, files: { 'redirected.md': 'must not save' } })).rejects.toThrow('after this run started');
  await expect(readFile(resolve(other, 'redirected.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('binds saved provenance and destination to structured host references', async () => {
  const { createSkillTools } = await import('../../src/host/skills.js');
  const { root, library } = await setup();
  const source = { instanceId: 'host-a', runId: 'work-a', number: 1 };
  const tools = createSkillTools({ mode: 'authoring', library, skills: await library.createRunSnapshot(), sourceRunReferences: [source] });
  const saved = await (tools.find(t => t.name === 'skill_save')!.execute as any)('call', { root, expectedPreferencesRevision: 0, files: { 'new.md': '# Verified' }, sourceRuns: [{ instanceId: 'fabricated', runId: 'wrong' }] });
  expect((await library.revisions(saved.details.id)).revisions.at(-1)?.sourceRuns).toEqual([source]);
  const updateTools = createSkillTools({ mode: 'authoring', library, skills: await library.createRunSnapshot(), destinationSkillId: saved.details.id, sourceRunReferences: [{ instanceId: 'host-a', runId: 'work-b', number: 2 }] });
  const update = updateTools.find(t => t.name === 'skill_save')!.execute as any;
  await expect(update('call', { root, expectedPreferencesRevision: 0, files: { 'wrong.md': 'Wrong destination' } })).rejects.toThrow('explicitly requested destination');
  await update('call', { root, expectedPreferencesRevision: 0, id: saved.details.id, expectedRevision: saved.details.revision, files: { 'new.md': '# Improved' } });
  expect((await library.revisions(saved.details.id)).revisions.at(-1)?.sourceRuns).toEqual([source, { instanceId: 'host-a', runId: 'work-b', number: 2 }]);
});

it('allows reading a disabled bundled skill for a new user copy while rejecting bundled writes', async () => {
  const { createSkillTools } = await import('../../src/host/skills.js');
  const { root, library, dir } = await setup(); await put(dir, 'mds/skills/sample/SKILL.md', '# Bundled procedure'); await library.refresh();
  const bundled = library.snapshot().skills.find(s => s.source === 'bundled')!;
  await library.update({ type: 'enabled', id: bundled.id, enabled: false, expectedRevision: 0 });
  const evidence: any[] = [];
  const tools = createSkillTools({ mode: 'authoring', library, skills: await library.createRunSnapshot(), onSkillRead: e => evidence.push(e) });
  const invoke = (name: string, input: unknown) => (tools.find(t => t.name === name)!.execute as any)('call', input);
  const read = await invoke('skill_edit_read', { id: bundled.id }); expect(read.details).toMatchObject({ copyOnly: true, content: '# Bundled procedure' }); expect(evidence[0].authoring).toBe(true);
  await expect(invoke('skill_save', { root, expectedPreferencesRevision: 1, id: bundled.id, expectedRevision: bundled.revision, files: { 'copy/SKILL.md': '# Changed' } })).rejects.toThrow('bundled');
  const copy = await invoke('skill_save', { root, expectedPreferencesRevision: 1, files: { 'copy/SKILL.md': read.details.content } }); expect(library.preview(copy.details.id).skill.source).toBe('user'); expect(library.preview(copy.details.id).skill.enabled).toBe(true);
});
