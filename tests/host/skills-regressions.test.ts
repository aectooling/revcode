import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { HostSkillLibrary, SKILL_LIMITS, createSkillTools } from "../../src/host/skills.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(writeFile).mockReset();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementation(actual.writeFile);
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(resolve(tmpdir(), "revcode-skill-regression-"));
  directories.push(dir);
  const root = resolve(dir, "library");
  const preferences = resolve(dir, "preferences.json");
  const library = new HostSkillLibrary(dir, preferences, root);
  await library.initialize();
  return { dir, root, preferences, library };
}

it("does not publish a torn transaction or edit files when staging fails", async () => {
  const { dir, root, preferences, library } = await setup();
  const saved = await library.save({ root, expectedPreferencesRevision: 0, files: { "one.md": "Original" } });
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementationOnce(async (path) => {
    expect(String(path)).toMatch(/\.pending\.json\.[\w-]+\.tmp$/);
    await actual.writeFile(path, '{"root":');
    throw new Error("Simulated interrupted staging write");
  });
  await expect(library.save({ root, expectedPreferencesRevision: 0, id: saved.id, expectedRevision: saved.revision, files: { "one.md": "Changed" } })).rejects.toThrow("interrupted staging write");
  expect(await readFile(resolve(root, "one.md"), "utf8")).toBe("Original");
  expect((await readdir(resolve(dir, "skill-revisions"))).some((name) => name.includes(".pending.json"))).toBe(false);
  const restarted = new HostSkillLibrary(dir, preferences, root);
  await restarted.initialize();
  expect(restarted.preview(saved.id).files["one.md"]).toBe("Original");
  await expect(restarted.save({ root, expectedPreferencesRevision: 0, files: { "two.md": "Next" } })).resolves.toHaveProperty("id");
});

it("ignores an unpublished partial staging file left by a process crash", async () => {
  const { dir, root, preferences } = await setup();
  await mkdir(resolve(dir, "skill-revisions"));
  await writeFile(resolve(dir, "skill-revisions", "crash.pending.json.fixture.tmp"), '{"root":');
  const restarted = new HostSkillLibrary(dir, preferences, root);
  await restarted.initialize();
  expect(restarted.snapshot().diagnostics).toEqual([]);
  await expect(restarted.save({ root, expectedPreferencesRevision: 0, files: { "one.md": "New" } })).resolves.toHaveProperty("id");
});

it("preserves malformed legacy transactions and blocks authoring without blocking startup", async () => {
  const { dir, root, preferences } = await setup();
  await writeFile(resolve(root, "one.md"), "Existing instructions");
  await mkdir(resolve(dir, "skill-revisions"));
  const transaction = resolve(dir, "skill-revisions", "legacy.pending.json");
  await writeFile(transaction, '{"root":');
  const restarted = new HostSkillLibrary(dir, preferences, root);
  await restarted.initialize();
  expect(restarted.snapshot().skills).toHaveLength(1);
  expect(restarted.snapshot().diagnostics.join()).toContain("Interrupted skill update:");
  expect(await readFile(transaction, "utf8")).toBe('{"root":');
  await expect(restarted.save({ root, expectedPreferencesRevision: 0, files: { "new.md": "New" } })).rejects.toThrow("requires recovery");
  await expect(readFile(resolve(root, "new.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects additions beyond the library cap, including loose C# and oversized files", async () => {
  const { root, library } = await setup();
  await Promise.all(Array.from({ length: SKILL_LIMITS.files - 2 }, (_, i) => writeFile(resolve(root, `a${i}.md`), "Existing")));
  await writeFile(resolve(root, "loose.cs"), "return true;");
  await writeFile(resolve(root, "oversized.md"), "x".repeat(SKILL_LIMITS.fileBytes + 1));
  await expect(library.save({ root, expectedPreferencesRevision: 0, files: { "zzz.md": "New" } })).rejects.toThrow("Library limited to 500");
  await expect(readFile(resolve(root, "zzz.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await rm(resolve(root, "oversized.md"));
  const saved = await library.save({ root, expectedPreferencesRevision: 0, files: { "zzz.md": "New" } });
  expect(library.preview(saved.id).files["zzz.md"]).toBe("New");
});

it("allows edits at capacity, rejects supporting-file growth, and releases capacity on restore", async () => {
  const { root, library } = await setup();
  const original = await library.save({ root, expectedPreferencesRevision: 0, files: { "a/SKILL.md": "Original" } });
  const expanded = await library.save({ root, expectedPreferencesRevision: 0, id: original.id, expectedRevision: original.revision, files: { "a/example.cs": "return true;" } });
  await Promise.all(Array.from({ length: SKILL_LIMITS.files - 2 }, (_, i) => writeFile(resolve(root, `z${i}.md`), "Existing")));
  const updated = await library.save({ root, expectedPreferencesRevision: 0, id: expanded.id, expectedRevision: expanded.revision, files: { "a/SKILL.md": "Updated" } });
  await expect(library.save({ root, expectedPreferencesRevision: 0, id: updated.id, expectedRevision: updated.revision, files: { "a/extra.cs": "return false;" } })).rejects.toThrow("Library limited to 500");
  expect(library.preview(updated.id).files["a/SKILL.md"]).toBe("Updated");
  await expect(readFile(resolve(root, "a/extra.cs"))).rejects.toMatchObject({ code: "ENOENT" });
  await library.restore({ root, expectedPreferencesRevision: 0, id: updated.id, expectedRevision: updated.revision, revision: original.revision });
  await expect(readFile(resolve(root, "a/example.cs"))).rejects.toMatchObject({ code: "ENOENT" });
  const next = await library.save({ root, expectedPreferencesRevision: 0, files: { "zzz.md": "New" } });
  expect(library.preview(next.id).files["zzz.md"]).toBe("New");
});

it("rejects hidden and excessively nested skill destinations before writing", async () => {
  const { root, library } = await setup();
  for (const path of [".hidden.md", ".hidden/SKILL.md", `${"nested/".repeat(SKILL_LIMITS.depth + 1)}SKILL.md`]) {
    await expect(library.save({ root, expectedPreferencesRevision: 0, files: { [path]: "New" } })).rejects.toThrow("discovery depth");
    await expect(readFile(resolve(root, path))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it.each(["é", "中", "😀"])("preserves %s across snapshot and authoring read boundaries", async (character) => {
  const { root, library } = await setup();
  const content = "a".repeat(SKILL_LIMITS.readBytes - 1) + character + " end";
  await writeFile(resolve(root, "one.md"), content);
  await library.refresh();
  const id = library.snapshot().skills[0].id;
  const snapshot = await library.createRunSnapshot([id]);
  const first = snapshot.read(id);
  expect(first.nextOffset).toBe(SKILL_LIMITS.readBytes - 1);
  expect(first.truncated).toBe(true);
  const second = snapshot.read(id, undefined, first.nextOffset);
  expect(first.content + second.content).toBe(content);
  expect(second.nextOffset).toBe(Buffer.byteLength(content));
  expect(second.truncated).toBe(false);
  const tool = createSkillTools({ mode: "authoring", library, skills: snapshot }).find((tool) => tool.name === "skill_edit_read")!;
  const invoke = async (offset: number) => (await tool.execute("read", { id, offset }) as any).details;
  const editFirst = await invoke(0);
  const editSecond = await invoke(editFirst.nextOffset);
  expect(editFirst.content + editSecond.content).toBe(content);
  expect(editSecond.nextOffset).toBe(Buffer.byteLength(content));
  expect(editSecond.truncated).toBe(false);
});

it("rejects split-character offsets and undersized ranges without corrupting text or stalling pagination", async () => {
  const { root, library } = await setup();
  await writeFile(resolve(root, "one.md"), "中x");
  const snapshot = await library.createRunSnapshot();
  const id = snapshot.library.skills[0].id;
  expect(() => snapshot.read(id, undefined, 1)).toThrow("character boundary");
  expect(() => snapshot.read(id, undefined, 0, 1)).toThrow("too small");
  expect(() => snapshot.read(id, undefined, 5)).toThrow("Invalid range");
  expect(snapshot.read(id, undefined, 0, 3)).toMatchObject({ content: "中", nextOffset: 3, truncated: true });
  expect(snapshot.read(id, undefined, 3, 1)).toMatchObject({ content: "x", nextOffset: 4, truncated: false });
  expect(snapshot.read(id, undefined, 4)).toMatchObject({ content: "", nextOffset: 4, truncated: false });
});
