import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  lstat,
  writeFile,
  unlink,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import lockfile from "proper-lockfile";
import {
  parseFrontmatter,
  formatSkillsForPrompt,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export const SKILL_LIMITS = {
  fileBytes: 256 * 1024,
  files: 500,
  catalogBytes: 24 * 1024,
  readBytes: 16 * 1024,
  contextBytes: 128 * 1024,
  revisions: 10,
  revisionBytes: 8 * 1024 * 1024,
} as const;
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  root: string;
  source: "bundled" | "user";
  enabled: boolean;
  revision: string;
  files: string[];
}
export interface SkillLibrarySnapshot {
  folder: string;
  revision: number;
  skills: SkillSummary[];
  diagnostics: string[];
}
export interface SkillPreview {
  skill: SkillSummary;
  files: Record<string, string>;
}
export interface SkillRevision {
  revision: string;
  createdAt: string;
  files: Record<string, string>;
  summary: string;
  changes: {
    path: string;
    before: string;
    after: string;
  }[];
  sourceRuns?: unknown[];
}
export interface SkillSaveInput {
  root: string;
  expectedPreferencesRevision: number;
  id?: string;
  expectedRevision?: string;
  files: Record<string, string>;
  sourceRuns?: unknown[];
}
export interface SkillReadEvidence {
  id: string;
  revision: string;
  path: string;
  offset: number;
  complete: boolean;
  authoring?: boolean;
}
export interface RunServices {
  sourceRunReferences?: {
    instanceId: string;
    runId: string;
    number?: number;
  }[];
  destinationSkillId?: string;
  mode: "execution" | "authoring";
  skills?: SkillRunSnapshot;
  library?: HostSkillLibrary;
  historyTools?: ToolDefinition[];
  onSkillRead?: (read: SkillReadEvidence) => void;
  withToolCall?: <T>(id: string, work: () => Promise<T>) => Promise<T>;
  onToolEvent?: (event: {
    type: "start" | "end";
    id: string;
    name: string;
    arguments?: unknown;
    result?: unknown;
    isError?: boolean;
  }) => Promise<void> | void;
}
type Preferences = {
  folder: string;
  disabled: string[];
  revision: number;
};
const canonical = (p: string) =>
  process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
const inside = (root: string, p: string) =>
  canonical(p) === canonical(root) ||
  canonical(p).startsWith(canonical(root) + sep);
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const revision = (files: Record<string, string>) =>
  digest(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
const supported = (p: string) =>
  [".md", ".cs"].includes(extname(p).toLowerCase());
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Discovery adapted from Hoppercode; see THIRD_PARTY_NOTICES.md. All run reads use copied bytes. */
export class HostSkillLibrary {
  private preferences: Preferences;
  private entries: SkillPreview[] = [];
  private diagnostics: string[] = [];
  constructor(
    private projectRoot: string,
    private preferencesPath: string,
    defaultFolder: string,
  ) {
    this.preferences = {
      folder: resolve(defaultFolder),
      disabled: [],
      revision: 0,
    };
  }
  async initialize() {
    await mkdir(dirname(this.preferencesPath), { recursive: true });
    await mkdir(this.preferences.folder, { recursive: true });
    await this.recoverPending();
    await this.refresh();
  }
  /** Interrupted saves roll back only when every destination still matches recorded before/after bytes. */
  async recoverPending() {
    await this.locked(async () => {
      const directory = resolve(
        dirname(this.preferencesPath),
        "skill-revisions",
      );
      for (const name of (await readdir(directory).catch(() => [])).filter(
        (p) => p.endsWith(".pending.json"),
      )) {
        const path = resolve(directory, name);
        const tx = JSON.parse(await readFile(path, "utf8")) as {
          root: string;
          before: Record<string, string>;
          after: Record<string, string>;
          changedFiles: string[];
        };
        tx.root = await realpath(tx.root);
        let safe = true;
        for (const file of tx.changedFiles) {
          const destination = await this.validatePath(tx.root, file);
          const current = await readFile(destination, "utf8").catch(
            (e: NodeJS.ErrnoException) => {
              if (e.code === "ENOENT") return undefined;
              throw e;
            },
          );
          if (current !== tx.before[file] && current !== tx.after[file]) {
            safe = false;
            break;
          }
        }
        if (!safe) continue;
        for (const file of tx.changedFiles) {
          const destination = await this.validatePath(tx.root, file);
          if (tx.before[file] === undefined)
            await unlink(destination).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== "ENOENT") throw e;
            });
          else {
            await mkdir(dirname(destination), { recursive: true });
            const temp = `${destination}.${randomUUID()}.tmp`;
            await writeFile(temp, tx.before[file], { mode: 0o600 });
            await rename(temp, destination);
          }
        }
        await unlink(path);
      }
    });
  }
  private async loadPreferences() {
    try {
      const p = JSON.parse(await readFile(this.preferencesPath, "utf8"));
      if (
        !isAbsolute(p.folder) ||
        !Array.isArray(p.disabled) ||
        !p.disabled.every((v: unknown) => typeof v === "string") ||
        !Number.isInteger(p.revision)
      )
        throw new Error("Invalid skills preferences.");
      this.preferences = p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  async refresh() {
    await this.loadPreferences();
    const entries: SkillPreview[] = [],
      diagnostics: string[] = [];
    for (const [configured, source] of [
      [resolve(this.projectRoot, "mds/skills"), "bundled"],
      [this.preferences.folder, "user"],
    ] as const) {
      let root: string;
      try {
        root = await realpath(configured);
      } catch {
        if (source === "user")
          diagnostics.push(`Folder unavailable: ${configured}`);
        continue;
      }
      const bundled = await realpath(
        resolve(this.projectRoot, "mds/skills"),
      ).catch(() => resolve(this.projectRoot, "mds/skills"));
      if (
        source === "user" &&
        (inside(root, bundled) || inside(bundled, root))
      ) {
        diagnostics.push("Choose a user folder separate from bundled skills.");
        continue;
      }
      const files: Record<string, string> = {},
        roots: string[] = [];
      let count = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 16) {
          diagnostics.push(`Nesting limit: ${dir}`);
          return;
        }
        const children = (await readdir(dir, { withFileTypes: true })).sort(
          (a, b) => a.name.localeCompare(b.name),
        );
        if (children.some((c) => c.name.toLowerCase() === "skill.md"))
          roots.push(dir);
        for (const child of children) {
          if (child.name.startsWith(".")) continue;
          const path = resolve(dir, child.name);
          try {
            if (child.isSymbolicLink() || !inside(root, await realpath(path))) {
              diagnostics.push(`Skipped link: ${path}`);
              continue;
            }
            if (child.isDirectory()) {
              await walk(path, depth + 1);
              continue;
            }
            if (!child.isFile() || !supported(path)) continue;
            if (++count > SKILL_LIMITS.files) {
              if (count === SKILL_LIMITS.files + 1)
                diagnostics.push(
                  `Library limited to ${SKILL_LIMITS.files} supported files.`,
                );
              continue;
            }
            if ((await lstat(path)).size > SKILL_LIMITS.fileBytes) {
              diagnostics.push(`File exceeds 256 KiB: ${path}`);
              continue;
            }
            const handle = await open(
              path,
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            );
            try {
              const buffer = Buffer.alloc(SKILL_LIMITS.fileBytes + 1);
              const { bytesRead } = await handle.read(
                buffer,
                0,
                buffer.length,
                0,
              );
              if (bytesRead > SKILL_LIMITS.fileBytes) {
                diagnostics.push(`File exceeds 256 KiB: ${path}`);
                continue;
              }
              files[path] = buffer.subarray(0, bytesRead).toString("utf8");
            } finally {
              await handle.close();
            }
          } catch (e) {
            diagnostics.push(`${path}: ${errorText(e)}`);
          }
        }
      };
      try {
        await walk(root, 0);
      } catch (e) {
        diagnostics.push(errorText(e));
      }
      const owner = (p: string) =>
        roots
          .filter((r) => inside(r, p))
          .sort((a, b) => b.length - a.length)[0];
      for (const path of Object.keys(files)) {
        if (
          extname(path).toLowerCase() !== ".md" ||
          (basename(path).toLowerCase() !== "skill.md" && owner(path))
        )
          continue;
        try {
          const { frontmatter, body } = parseFrontmatter(files[path]);
          const name = String(
            frontmatter.name ||
              (basename(path).toLowerCase() === "skill.md"
                ? basename(dirname(path))
                : basename(path, extname(path))),
          ).slice(0, 120);
          const description = String(
            frontmatter.description ||
              body
                .split("\n")
                .map((l) => l.replace(/^#+\s*/, "").trim())
                .find(Boolean) ||
              name,
          ).slice(0, 1024);
          const owned =
            basename(path).toLowerCase() === "skill.md"
              ? Object.keys(files).filter((p) => owner(p) === dirname(path))
              : [path];
          const contents = Object.fromEntries(
            owned.map((p) => [
              relative(root, p).split(sep).join("/"),
              files[p],
            ]),
          );
          const id = `${source}:${digest(canonical(root)).slice(0, 16)}:${relative(root, path).split(sep).join("/").toLowerCase()}`;
          entries.push({
            skill: {
              id,
              name,
              description,
              path,
              root,
              source,
              enabled: !this.preferences.disabled.includes(id),
              revision: revision(contents),
              files: Object.keys(contents),
            },
            files: contents,
          });
        } catch (e) {
          diagnostics.push(`${path}: ${errorText(e)}`);
        }
      }
    }
    const pending = await readdir(
      resolve(dirname(this.preferencesPath), "skill-revisions"),
    ).catch(() => []);
    for (const path of pending.filter((p) => p.endsWith(".pending.json")))
      diagnostics.push(
        `Interrupted skill update: recovery record ${resolve(dirname(this.preferencesPath), "skill-revisions", path)}. Authoring is blocked until recovered.`,
      );
    this.entries = entries;
    this.diagnostics = diagnostics;
  }
  snapshot(): SkillLibrarySnapshot {
    return structuredClone({
      folder: this.preferences.folder,
      revision: this.preferences.revision,
      skills: this.entries.map((e) => e.skill),
      diagnostics: this.diagnostics,
    });
  }
  preview(id: string): SkillPreview {
    const entry = this.entries.find((e) => e.skill.id === id);
    if (!entry)
      throw new Error("Skill unavailable. Refresh and select it again.");
    return structuredClone(entry);
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const release = await lockfile.lock(this.preferencesPath, {
      realpath: false,
      retries: { retries: 30, minTimeout: 25, maxTimeout: 200 },
    });
    try {
      await this.loadPreferences();
      return await fn();
    } finally {
      await release();
    }
  }
  async update(
    input:
      | {
          expectedRevision: number;
          type: "folder";
          folder: string;
        }
      | {
          expectedRevision: number;
          type: "enabled";
          id: string;
          enabled: boolean;
        },
  ) {
    await this.locked(async () => {
      if (input.expectedRevision !== this.preferences.revision)
        throw new Error(
          "Conflict: skill preferences changed. Refresh and retry.",
        );
      const next = structuredClone(this.preferences);
      if (input.type === "folder") {
        if (!isAbsolute(input.folder))
          throw new Error("Choose an absolute existing folder.");
        next.folder = await realpath(input.folder);
        if (!(await lstat(next.folder)).isDirectory())
          throw new Error("Choose an existing folder.");
        const bundled = await realpath(
          resolve(this.projectRoot, "mds/skills"),
        ).catch(() => resolve(this.projectRoot, "mds/skills"));
        if (inside(next.folder, bundled) || inside(bundled, next.folder))
          throw new Error("Choose a user folder separate from bundled skills.");
      } else {
        await this.refresh();
        this.preview(input.id);
        next.disabled = [
          ...new Set(
            next.disabled
              .filter((id) => id !== input.id)
              .concat(input.enabled ? [] : [input.id]),
          ),
        ];
      }
      next.revision++;
      const temp = `${this.preferencesPath}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, this.preferencesPath);
      this.preferences = next;
    });
    await this.refresh();
    return this.snapshot();
  }
  async createRunSnapshot(selectedIds: string[] = []) {
    return this.locked(async () => {
      await this.refresh();
      return new SkillRunSnapshot(
        this.entries.filter((e) => e.skill.enabled),
        selectedIds,
        this.snapshot(),
      );
    });
  }
  private historyPath(id: string) {
    return resolve(
      dirname(this.preferencesPath),
      "skill-revisions",
      digest(id) + ".json",
    );
  }
  async revisions(id: string): Promise<{
    revisions: SkillRevision[];
    expired: boolean;
  }> {
    try {
      return JSON.parse(await readFile(this.historyPath(id), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { revisions: [], expired: false };
      throw e;
    }
  }
  private async validatePath(root: string, path: string) {
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path
        .split("/")
        .some(
          (p) =>
            !p ||
            p === "." ||
            p === ".." ||
            /[<>:"|?*\x00-\x1f]/.test(p) ||
            /[. ]$/.test(p) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
        ) ||
      !supported(path)
    )
      throw new Error(`Invalid supported-file path: ${path}`);
    const full = resolve(root, path);
    if (!inside(root, full)) throw new Error("Path escapes skill library.");
    let parent = root;
    for (const part of path.split("/")) {
      const children = await readdir(parent).catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return [];
          throw e;
        },
      );
      const collision = children.find(
        (c) => c.toLowerCase() === part.toLowerCase() && c !== part,
      );
      if (collision)
        throw new Error(`Case-insensitive path collision: ${path}`);
      parent = resolve(parent, part);
      try {
        if (
          (await lstat(parent)).isSymbolicLink() ||
          !inside(root, await realpath(parent))
        )
          throw new Error("Filesystem links are not writable.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return full;
  }
  async save(input: SkillSaveInput) {
    return this.saveInternal(input, false);
  }
  private async saveInternal(
    input: SkillSaveInput,
    restore: boolean,
  ): Promise<{
    id: string;
    revision: string;
    changedFiles: string[];
    summary: string;
  }> {
    return this.locked(async () => {
      await this.refresh();
      if (
        this.diagnostics.some((d) => d.startsWith("Interrupted skill update:"))
      )
        throw new Error(
          "Interrupted skill update requires recovery from the pending revision record before authoring.",
        );
      const root = await realpath(this.preferences.folder);
      const bundled = await realpath(
        resolve(this.projectRoot, "mds/skills"),
      ).catch(() => resolve(this.projectRoot, "mds/skills"));
      if (inside(root, bundled) || inside(bundled, root))
        throw new Error("Bundled library cannot be authored.");
      if (
        canonical(root) !== canonical(await realpath(input.root)) ||
        input.expectedPreferencesRevision !== this.preferences.revision
      )
        throw new Error("Conflict: library folder or preferences changed.");
      const old = input.id ? this.preview(input.id) : undefined;
      if (
        old &&
        (old.skill.source !== "user" ||
          old.skill.revision !== input.expectedRevision)
      )
        throw new Error("Conflict: skill changed or is bundled and immutable.");
      const files = restore ? input.files : { ...old?.files, ...input.files };
      if (
        !Object.keys(files).length ||
        Object.keys(files).length > SKILL_LIMITS.files
      )
        throw new Error("Invalid file count.");
      const names = Object.keys(files);
      if (new Set(names.map((p) => p.toLowerCase())).size !== names.length)
        throw new Error("Case-insensitive destination collision.");
      for (const [path, content] of Object.entries(files)) {
        await this.validatePath(root, path);
        if (
          typeof content !== "string" ||
          Buffer.byteLength(content) > SKILL_LIMITS.fileBytes
        )
          throw new Error("File exceeds 256 KiB.");
      }
      const entryPath = old
        ? relative(root, old.skill.path).split(sep).join("/")
        : names.find((p) => basename(p).toLowerCase() === "skill.md") ||
          (names.length === 1 && extname(names[0]).toLowerCase() === ".md"
            ? names[0]
            : undefined);
      if (!entryPath || !files[entryPath]?.trim())
        throw new Error(
          "Provide a nonempty SKILL.md or one standalone Markdown file.",
        );
      const skillDir = dirname(entryPath);
      if (
        names.some(
          (p) =>
            p !== entryPath &&
            (basename(entryPath).toLowerCase() !== "skill.md" ||
              !inside(resolve(root, skillDir), resolve(root, p)) ||
              basename(p).toLowerCase() === "skill.md"),
        )
      )
        throw new Error(
          "Files must belong to one skill, without nested skill roots.",
        );
      parseFrontmatter(files[entryPath]);
      for (const other of this.entries.filter(
        (e) =>
          e.skill.id !== old?.skill.id &&
          canonical(e.skill.root) === canonical(root),
      )) {
        if (
          names.some(
            (p) =>
              other.files[p] !== undefined ||
              (basename(other.skill.path).toLowerCase() === "skill.md" &&
                inside(dirname(other.skill.path), resolve(root, p))),
          ) ||
          (basename(entryPath).toLowerCase() === "skill.md" &&
            inside(resolve(root, skillDir), other.skill.path))
        )
          throw new Error("Conflict: destination overlaps another skill.");
      }
      for (const path of names) {
        if (old?.files[path] !== undefined) continue;
        try {
          await lstat(resolve(root, path));
          throw new Error(`Conflict: destination exists: ${path}`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const id =
        old?.skill.id ||
        `user:${digest(canonical(root)).slice(0, 16)}:${entryPath.toLowerCase()}`;
      const changedFiles = [
        ...new Set([...Object.keys(old?.files || {}), ...names]),
      ].filter((p) => old?.files[p] !== files[p]);
      const nextRevision = revision(files),
        summary = `${old ? "Updated" : "Created"} ${entryPath}: ${changedFiles.length} changed file(s).`;
      const history = await this.revisions(id);
      if (
        old &&
        !history.revisions.some((r) => r.revision === old.skill.revision)
      )
        history.revisions.push({
          revision: old.skill.revision,
          createdAt: new Date().toISOString(),
          files: old.files,
          summary: "Recovery copy before update.",
          changes: [],
        });
      history.revisions.push({
        revision: nextRevision,
        createdAt: new Date().toISOString(),
        files,
        summary,
        changes: changedFiles.map((path) => ({
          path,
          before: old?.files[path] || "",
          after: files[path] || "",
        })),
        sourceRuns: [
          ...new Map(
            [
              ...(history.revisions.at(-1)?.sourceRuns || []),
              ...(input.sourceRuns || []),
            ].map((ref) => [JSON.stringify(ref), ref]),
          ).values(),
        ],
      });
      while (
        history.revisions.length > SKILL_LIMITS.revisions ||
        Buffer.byteLength(JSON.stringify(history)) > SKILL_LIMITS.revisionBytes
      ) {
        if (history.revisions.length <= (old ? 2 : 1))
          throw new Error(
            "Revision recovery budget exceeded; no files changed.",
          );
        history.revisions.shift();
        history.expired = true;
      }
      const historyPath = this.historyPath(id);
      await mkdir(dirname(historyPath), { recursive: true });
      // Durable transaction stores complete before/after bytes before any destination is replaced.
      const transaction = `${historyPath}.pending.json`;
      await writeFile(
        transaction,
        JSON.stringify({
          root,
          before: old?.files || {},
          after: files,
          changedFiles,
          history,
        }),
        { mode: 0o600 },
      );
      for (const path of changedFiles) {
        await this.validatePath(root, path);
        const current = await readFile(resolve(root, path), "utf8").catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return undefined;
            throw e;
          },
        );
        if (current !== old?.files[path])
          throw new Error(
            `Conflict: external edit observed in ${path}; recovery record retained.`,
          );
      }
      for (const path of changedFiles) {
        const destination = await this.validatePath(root, path);
        if (files[path] === undefined) await unlink(destination);
        else {
          await mkdir(dirname(destination), { recursive: true });
          const temp = `${destination}.${randomUUID()}.tmp`;
          await writeFile(temp, files[path], { mode: 0o600 });
          await rename(temp, destination);
        }
      }
      const temp = `${historyPath}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(history), { mode: 0o600 });
      await rename(temp, historyPath);
      await unlink(transaction);
      await this.refresh();
      return { id, revision: nextRevision, changedFiles, summary };
    });
  }
  async restore(input: {
    root: string;
    id: string;
    expectedRevision: string;
    revision: string;
    expectedPreferencesRevision: number;
  }) {
    const previous = (await this.revisions(input.id)).revisions.find(
      (r) => r.revision === input.revision,
    );
    if (!previous) throw new Error("Revision expired or unavailable.");
    return this.saveInternal({ ...input, files: previous.files }, true);
  }
}
export class SkillRunSnapshot {
  readonly id = randomUUID();
  readonly selected: SkillSummary[];
  readonly catalog: Skill[] = [];
  readonly omitted: number;
  private entries: SkillPreview[];
  private consumed = 0;
  constructor(
    entries: SkillPreview[],
    selectedIds: string[],
    readonly library: SkillLibrarySnapshot,
  ) {
    this.entries = structuredClone(entries);
    this.selected = [...new Set(selectedIds)].map((id) => {
      const e = this.entries.find((e) => e.skill.id === id);
      if (!e)
        throw new Error(
          "Selected skill is disabled or unavailable. Refresh and select it again.",
        );
      return e.skill;
    });
    const selected = new Set(selectedIds);
    const ordered = [...this.entries].sort(
      (a, b) =>
        Number(selected.has(b.skill.id)) - Number(selected.has(a.skill.id)) ||
        a.skill.id.localeCompare(b.skill.id),
    );
    for (const e of ordered) {
      const skill: Skill = {
        name: e.skill.name,
        description: `${e.skill.description} [id=${e.skill.id}]`,
        filePath: e.skill.path,
        baseDir: dirname(e.skill.path),
        disableModelInvocation: false,
        sourceInfo: {
          path: e.skill.path,
          source: e.skill.source,
          scope: "user",
          origin: "top-level",
          baseDir: dirname(e.skill.path),
        },
      };
      if (
        Buffer.byteLength(formatSkillsForPrompt([...this.catalog, skill])) >
        SKILL_LIMITS.catalogBytes
      ) {
        if (selected.has(e.skill.id))
          throw new Error(
            "Selected skills exceed catalog budget. Narrow your selection.",
          );
        continue;
      }
      this.catalog.push(skill);
    }
    this.omitted = entries.length - this.catalog.length;
    this.consumed = Buffer.byteLength(formatSkillsForPrompt(this.catalog));
    if (
      this.selected.reduce(
        (n, s) =>
          n +
          Buffer.byteLength(
            this.entries.find((e) => e.skill.id === s.id)!.files[
              relative(s.root, s.path).split(sep).join("/")
            ],
          ) +
          (1 +
            Math.ceil(
              Buffer.byteLength(
                this.entries.find((e) => e.skill.id === s.id)!.files[
                  relative(s.root, s.path).split(sep).join("/")
                ],
              ) / SKILL_LIMITS.readBytes,
            )) *
            1024,
        this.consumed,
      ) > SKILL_LIMITS.contextBytes
    )
      throw new Error(
        "Selected instructions exceed context budget. Narrow your selection.",
      );
  }
  charge(bytes: number) {
    if (this.consumed + bytes > SKILL_LIMITS.contextBytes)
      throw new Error("Cumulative skill context budget reached.");
    this.consumed += bytes;
  }
  read(id: string, path?: string, offset = 0, limit = SKILL_LIMITS.readBytes) {
    const e = this.entries.find(
      (e) => e.skill.id === id || canonical(e.skill.path) === canonical(id),
    );
    if (!e) throw new Error("Read limited to enabled run-snapshot skills.");
    const key =
      path || relative(e.skill.root, e.skill.path).split(sep).join("/");
    const content = e.files[key];
    if (content === undefined)
      throw new Error("File unavailable in this skill snapshot.");
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1
    )
      throw new Error("Invalid range.");
    const bytes = Buffer.from(content);
    const end = Math.min(
      bytes.length,
      offset + Math.min(limit, SKILL_LIMITS.readBytes),
    );
    const result = bytes.subarray(offset, end).toString("utf8");
    if (this.consumed + Buffer.byteLength(result) > SKILL_LIMITS.contextBytes)
      throw new Error("Cumulative skill context budget reached.");
    this.charge(Buffer.byteLength(result) + 512);
    return {
      id: e.skill.id,
      revision: e.skill.revision,
      path: key,
      offset,
      nextOffset: end,
      complete: offset === 0 && end === bytes.length,
      truncated: end < bytes.length,
      totalBytes: bytes.length,
      content: result,
    };
  }
  search(query: string) {
    const matches = this.entries.filter((e) =>
      `${e.skill.name} ${e.skill.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
    const results: SkillSummary[] = [];
    for (const entry of matches.slice(0, 20)) {
      if (
        Buffer.byteLength(JSON.stringify([...results, entry.skill])) >
        SKILL_LIMITS.readBytes
      )
        break;
      results.push(entry.skill);
    }
    this.charge(Buffer.byteLength(JSON.stringify(results)));
    return { skills: results, omitted: matches.length - results.length };
  }
}
export function createSkillTools(services: RunServices): ToolDefinition[] {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  });
  const tools: ToolDefinition[] = [];
  let authoringBytes = 0;
  const boundLibrary = structuredClone(
    services.skills?.library || services.library?.snapshot(),
  );
  const assertAuthoringBinding = async () => {
    await services.library!.refresh();
    const current = services.library!.snapshot();
    if (
      !boundLibrary ||
      canonical(current.folder) !== canonical(boundLibrary.folder) ||
      current.revision !== boundLibrary.revision
    )
      throw new Error(
        "Conflict: library settings changed after this run started. Start a new authoring run.",
      );
  };
  if (services.skills)
    tools.push(
      {
        name: "read",
        label: "Read skill",
        description:
          "Read enabled immutable skill Markdown/C# by skill ID or catalog path, with byte offset/limit. Truncated reads are incomplete. No other filesystem access.",
        parameters: Type.Object({
          path: Type.String(),
          file: Type.Optional(Type.String()),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        execute: async (_id, p: any) => {
          const value = services.skills!.read(
            p.path,
            p.file,
            p.offset,
            p.limit,
          );
          services.onSkillRead?.(value);
          return result(value);
        },
      },
      {
        name: "skills_search",
        label: "Search skills",
        description:
          "Search enabled run-snapshot skills omitted from the bounded catalog.",
        parameters: Type.Object({ query: Type.String() }),
        execute: async (_id, p: any) =>
          result(services.skills!.search(p.query)),
      },
    );
  if (services.library)
    tools.push(
      {
        name: "skill_edit_read",
        label: "Read skill for editing",
        description:
          "Read a skill, including disabled skills, for explicitly requested authoring. Bundled skills are copy-only: create a new user skill without an existing ID. Does not activate workflow instructions.",
        parameters: Type.Object({
          id: Type.String(),
          file: Type.Optional(Type.String()),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        execute: async (_id, p: any) => {
          await assertAuthoringBinding();
          const preview = services.library!.preview(p.id);
          const file =
            p.file ||
            relative(preview.skill.root, preview.skill.path)
              .split(sep)
              .join("/");
          if (preview.files[file] === undefined)
            throw new Error("File unavailable.");
          const bytes = Buffer.from(preview.files[file]);
          const offset = p.offset || 0;
          const end = Math.min(bytes.length, offset + SKILL_LIMITS.readBytes);
          const content = bytes.subarray(offset, end).toString("utf8");
          authoringBytes += Buffer.byteLength(content) + 512;
          services.skills?.charge(Buffer.byteLength(content) + 512);
          if (authoringBytes > SKILL_LIMITS.contextBytes)
            throw new Error("Authoring context budget reached.");
          services.onSkillRead?.({
            id: preview.skill.id,
            revision: preview.skill.revision,
            path: file,
            offset,
            complete: offset === 0 && end === bytes.length,
            authoring: true,
          });
          return result({
            skill: preview.skill,
            copyOnly: preview.skill.source === "bundled",
            authoringRoot: boundLibrary!.folder,
            file,
            content,
            offset,
            nextOffset: end,
            truncated: end < bytes.length,
            totalBytes: bytes.length,
            preferencesRevision: services.library!.snapshot().revision,
            authoring: true,
          });
        },
      },
      {
        name: "skill_save",
        label: "Create or update skill",
        description:
          "Create or update a user skill with Markdown and C# supporting files. Requires root/preferences revision and existing ID/revision for updates. Never overwrite concurrent edits. Record source-run provenance. Saves apply next run. Use history evidence honestly; parameterize incidental IDs and do not persist secrets.",
        parameters: Type.Object({
          root: Type.String(),
          expectedPreferencesRevision: Type.Integer(),
          id: Type.Optional(Type.String()),
          expectedRevision: Type.Optional(Type.String()),
          files: Type.Record(Type.String(), Type.String()),
          sourceRuns: Type.Optional(Type.Array(Type.Unknown())),
        }),
        execute: async (_id, p: any) => {
          await assertAuthoringBinding();
          if (
            canonical(await realpath(p.root)) !==
              canonical(await realpath(boundLibrary!.folder)) ||
            p.expectedPreferencesRevision !== boundLibrary!.revision
          )
            throw new Error(
              "Conflict: authoring is bound to the library accepted at run start.",
            );
          if (
            services.destinationSkillId &&
            p.id !== services.destinationSkillId
          )
            throw new Error(
              "Conflict: update the explicitly requested destination skill.",
            );
          return result(
            await services.library!.save({
              ...p,
              root: boundLibrary!.folder,
              expectedPreferencesRevision: boundLibrary!.revision,
              sourceRuns: services.sourceRunReferences || [],
            }),
          );
        },
      },
    );
  return [...tools, ...(services.historyTools || [])];
}
