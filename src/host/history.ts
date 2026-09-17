import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  HISTORY_LIMITS,
  RETENTION_DESCRIPTION,
  type HistoryQuery,
  type RunDetail,
  type RunSummary,
} from "./history-types.js";

export function bounded(
  value: unknown,
  bytes: number = HISTORY_LIMITS.resultBytes,
): unknown {
  const json = JSON.stringify(value ?? null);
  const originalBytes = Buffer.byteLength(json);
  if (originalBytes <= bytes) return value;
  const result = {
    truncated: true,
    originalBytes,
    preview: "",
    notice: "Read the source record for retained evidence.",
  };
  if (Buffer.byteLength(JSON.stringify(result)) > bytes)
    return bytes >= 18 ? { truncated: true } : null;
  // JSON escaping can expand a preview (quotes/control characters) by several times.
  let low = 0,
    high = json.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    result.preview = json.slice(0, middle);
    if (Buffer.byteLength(JSON.stringify(result)) <= bytes) low = middle;
    else high = middle - 1;
  }
  result.preview = json.slice(0, low);
  return result;
}
export class RunHistory {
  readonly summaries = new Map<string, RunSummary>();
  readonly protected = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private artifactBytes = 0;
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const task = this.chain.then(work);
    this.chain = task.catch(() => {});
    return task;
  }
  private constructor(private directory: string) {}
  static async open(directory: string) {
    const history = new RunHistory(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(resolve(directory, "artifacts"), {
      recursive: true,
      mode: 0o700,
    });
    // Detail is published before summary on every save. Reconcile interrupted
    // publications before recovery, but respect summary-first retention tombstones.
    const files = new Set(await readdir(directory));
    for (const file of files)
      if (file.endsWith(".detail.json")) {
        const id = file.slice(0, -".detail.json".length);
        const summary = files.has(`${id}.summary.json`)
          ? JSON.parse(await readFile(history.file(id, "summary"), "utf8")) as RunSummary
          : undefined;
        if (summary?.detailsAvailable === false) continue;
        const detail = JSON.parse(
          await readFile(history.file(id, "detail"), "utf8"),
        ) as RunDetail;
        if (detail.run.id !== id)
          throw new Error(
            "History detail identity does not match its filename.",
          );
        if (JSON.stringify(summary) === JSON.stringify(detail.run)) continue;
        await history.atomic(
          history.file(id, "summary"),
          JSON.stringify(detail.run),
        );
      }
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".summary.json")) continue;
      const run = JSON.parse(
        await readFile(resolve(directory, file), "utf8"),
      ) as RunSummary;
      history.summaries.set(run.id, run);
      if (run.detailsAvailable) {
        const detail = await history.detail(run.id);
        if (
          run.status !== "running" &&
          !detail.calls.some((c) => c.status === "running") &&
          !detail.operations.some(
            (o) =>
              !["succeeded", "failed", "cancelled", "unknown"].includes(
                o.status,
              ),
          )
        )
          continue;
        detail.run.status = "interrupted";
        detail.run.endedAt = new Date().toISOString();
        for (const call of detail.calls)
          if (call.status === "running") {
            call.status = "unknown";
            call.error = "Host restarted before completion. Do not replay.";
          }
        for (const op of detail.operations)
          if (!["succeeded", "failed", "cancelled"].includes(op.status)) {
            op.status = "unknown";
            op.error =
              "Host restarted before a confirmed native outcome. Do not replay.";
          }
        await history.save(detail);
      }
    }
    // Only after every retained detail has been read successfully is orphan cleanup safe.
    const referenced = new Set<string>();
    let completeReferences = true;
    for (const run of history.summaries.values()) {
      if (!run.detailsAvailable) {
        await rm(history.file(run.id, "detail"), { force: true });
        continue;
      }
      const detail = await history.detail(run.id);
      if (
        detail.missingEvidence?.includes("Recorded detail file is unavailable.")
      )
        completeReferences = false;
      for (const call of detail.calls)
        for (const artifact of call.artifacts ?? []) referenced.add(artifact);
    }
    for (const name of await readdir(resolve(directory, "artifacts"))) {
      if (!/^[a-zA-Z0-9-]+\.png(?:\.[a-zA-Z0-9-]+\.tmp)?$/.test(name)) continue;
      const file = resolve(directory, "artifacts", name);
      if (
        !referenced.has(name) &&
        (completeReferences || name.endsWith(".tmp"))
      )
        await rm(file, { force: true });
      else history.artifactBytes += (await stat(file)).size;
    }
    for (const name of await readdir(directory))
      if (
        /^[a-zA-Z0-9-]+\.(detail|summary)\.json\.[a-zA-Z0-9-]+\.tmp$/.test(name)
      )
        await rm(resolve(directory, name), { force: true });
    return history;
  }
  private file(id: string, suffix: string) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id))
      throw new Error("Invalid history reference.");
    return resolve(this.directory, `${id}.${suffix}.json`);
  }
  private async atomic(file: string, data: string | Buffer) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }
  get nextNumber() {
    let number = 0;
    for (const run of this.summaries.values())
      number = Math.max(number, run.number);
    return number + 1;
  }
  list(query: HistoryQuery = {}) {
    const limit = Math.min(
      HISTORY_LIMITS.maxPageSize,
      Math.max(1, query.limit ?? HISTORY_LIMITS.pageSize),
    );
    const before = query.cursor ? Number(query.cursor) : Infinity;
    if (
      query.cursor &&
      (!/^[1-9]\d*$/.test(query.cursor) || !Number.isSafeInteger(before))
    )
      throw new Error("Invalid history cursor.");
    const matched = [...this.summaries.values()]
      .filter(
        (r) =>
          r.number < before &&
          (!query.threadId || (r.threadId ?? "legacy") === query.threadId) &&
          (!query.search ||
            r.promptPreview
              .toLowerCase()
              .includes(query.search.toLowerCase())) &&
          (!query.errorsOnly ||
            r.failedCalls > 0 ||
            r.status === "failed" ||
            r.status === "interrupted") &&
          (!query.tool || r.toolNames.includes(query.tool)),
      )
      .sort((a, b) => b.number - a.number);
    const runs = matched
      .slice(0, limit)
      .map((run) => ({
        ...run,
        promptPreview: run.promptPreview.slice(0, 240),
      }));
    return {
      runs,
      nextCursor:
        matched.length > limit ? String(runs.at(-1)!.number) : undefined,
      retention: RETENTION_DESCRIPTION,
    };
  }
  async detail(id: string): Promise<RunDetail> {
    await this.chain;
    return this.readDetail(id);
  }
  private async readDetail(id: string): Promise<RunDetail> {
    const run = this.summaries.get(id);
    if (!run) throw new Error("Run not found in this host history.");
    if (!run.detailsAvailable)
      return {
        run,
        calls: [],
        messages: [],
        operations: [],
        missingEvidence: [
          "Run details expired under the history retention limits.",
        ],
      };
    try {
      const detail = JSON.parse(
        await readFile(this.file(id, "detail"), "utf8"),
      ) as RunDetail;
      return { ...detail, run };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return {
        run,
        calls: [],
        messages: [],
        operations: [],
        missingEvidence: ["Recorded detail file is unavailable."],
      };
    }
  }
  save(detail: RunDetail) {
    const copy = structuredClone(detail);
    return this.serialize(async () => {
      copy.run.callCount = copy.calls.length;
      copy.run.failedCalls = copy.calls.filter(
        (c) => c.status === "failed" || c.status === "unknown",
      ).length;
      copy.run.toolNames = [...new Set(copy.calls.map((c) => c.name))];
      copy.run.detailsAvailable = true;
      let data = JSON.stringify(copy);
      // A result may arrive after admission; recovery evidence must be retained even
      // if that result crosses the soft detail budget. Block further calls instead.
      if (Buffer.byteLength(data) > HISTORY_LIMITS.detailBytes) {
        copy.missingEvidence ??= [];
        if (
          !copy.missingEvidence.includes(
            "Run detail budget reached; further work is blocked.",
          )
        )
          copy.missingEvidence.push(
            "Run detail budget reached; further work is blocked.",
          );
      }
      // Include the metadata itself, so admission uses the actual serialized size.
      copy.run.detailBytes = 0;
      do {
        copy.run.detailBytes = Buffer.byteLength(JSON.stringify(copy));
        data = JSON.stringify(copy);
      } while (copy.run.detailBytes !== Buffer.byteLength(data));
      await this.atomic(this.file(copy.run.id, "detail"), data);
      await this.atomic(
        this.file(copy.run.id, "summary"),
        JSON.stringify(copy.run),
      );
      this.summaries.set(copy.run.id, copy.run);
      Object.assign(detail.run, copy.run);
    });
  }
  /** Admission rollback only, before any tool/native activity could have begun. */
  discardUnaccepted(id: string) {
    return this.serialize(async () => {
      const file = this.file(id, "detail");
      let detail: RunDetail;
      try {
        detail = JSON.parse(await readFile(file, "utf8")) as RunDetail;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          !this.summaries.has(id)
        )
          return;
        throw error;
      }
      if (
        detail.run.id !== id ||
        detail.run.status !== "running" ||
        detail.calls.length ||
        detail.operations.length
      )
        throw new Error(
          "Cannot discard a run with recorded activity or a terminal outcome.",
        );
      await rm(file, { force: true });
      await rm(this.file(id, "summary"), { force: true });
      this.summaries.delete(id);
    });
  }
  async prepare() {
    await this.prune();
    const retained = [...this.summaries.values()].filter(
      (r) => r.detailsAvailable,
    );
    if (
      retained.reduce((n, r) => n + (r.detailBytes ?? 0), 0) >=
        HISTORY_LIMITS.aggregateTextBytes ||
      retained.reduce((n, r) => n + (r.artifactBytes ?? 0), 0) >=
        HISTORY_LIMITS.aggregateArtifactBytes
    )
      throw new Error(
        "History storage is full of protected evidence. Resolve pending outcomes before accepting more work.",
      );
  }
  prune() {
    return this.serialize(() => this.pruneSerialized());
  }
  private async pruneSerialized() {
    const retained = [...this.summaries.values()]
      .filter((r) => r.detailsAvailable)
      .sort((a, b) => a.number - b.number);
    let count = retained.filter((r) => r.status !== "running").length;
    let bytes = retained.reduce((n, r) => n + (r.detailBytes ?? 0), 0);
    let images = retained.reduce((n, r) => n + (r.artifactBytes ?? 0), 0);
    for (const run of retained) {
      if (
        count <= HISTORY_LIMITS.completedDetails &&
        bytes < HISTORY_LIMITS.aggregateTextBytes &&
        images < HISTORY_LIMITS.aggregateArtifactBytes
      )
        break;
      if (run.status === "running" || this.protected.has(run.id)) continue;
      const detail = await this.readDetail(run.id);
      if (
        detail.missingEvidence?.includes("Recorded detail file is unavailable.")
      )
        continue;
      if (
        detail.operations.some(
          (op) => !["succeeded", "failed", "cancelled"].includes(op.status),
        ) ||
        detail.calls.some(
          (c) => c.status === "unknown" || c.status === "running",
        )
      )
        continue;
      bytes -= run.detailBytes ?? 0;
      images -= run.artifactBytes ?? 0;
      count--;
      const expired = { ...run, detailsAvailable: false };
      await this.atomic(this.file(run.id, "summary"), JSON.stringify(expired));
      this.summaries.set(run.id, expired);
      await rm(this.file(run.id, "detail"), { force: true });
      for (const call of detail.calls)
        for (const artifact of call.artifacts) {
          const file = this.artifactFile(artifact);
          const size = await stat(file).then(
            (s) => s.size,
            () => 0,
          );
          await rm(file, { force: true });
          this.artifactBytes = Math.max(0, this.artifactBytes - size);
        }
    }
  }
  private artifactFile(id: string) {
    if (!/^[a-zA-Z0-9-]+\.png$/.test(id))
      throw new Error("Invalid image reference.");
    return resolve(this.directory, "artifacts", id);
  }
  image(id: string) {
    return readFile(this.artifactFile(id));
  }
  result(
    value: unknown,
    detail: RunDetail,
    artifacts: string[],
  ): Promise<unknown> {
    return this.serialize(async () => {
      const images = new Map<string, unknown>();
      const visit = async (item: any, depth = 0): Promise<any> => {
        if (depth > 12)
          return { truncated: true, notice: "Maximum result nesting reached." };
        if (typeof item === "string") {
          // SDK text blocks often repeat the full structured result as JSON.
          const text = item.trim();
          if (text.startsWith("{") || text.startsWith("[")) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* ordinary text */
            }
            if (parsed !== undefined)
              return JSON.stringify(await visit(parsed, depth + 1));
          }
          return item.replace(
            /data:image\/[a-z0-9.+-]+;base64,[a-zA-Z0-9+/=\r\n]+/gi,
            "[Image data omitted; see retained artifact.]",
          );
        }
        if (!item || typeof item !== "object") return item;
        if (
          typeof item.data === "string" &&
          (item.type === "image" ||
            (typeof item.mimeType === "string" &&
              item.mimeType.startsWith("image/")))
        ) {
          if (images.has(item.data)) return images.get(item.data);
          const bytes = Buffer.from(item.data, "base64");
          let result: unknown;
          if (bytes.length > HISTORY_LIMITS.artifactBytes)
            result = {
              type: "image",
              unavailable: "Image exceeds retention limit.",
            };
          else if (
            this.artifactBytes + bytes.length >
            HISTORY_LIMITS.aggregateArtifactBytes
          )
            result = {
              type: "image",
              unavailable: "Image storage budget exhausted.",
            };
          else {
            const id = `${randomUUID()}.png`;
            await this.atomic(this.artifactFile(id), bytes);
            this.artifactBytes += bytes.length;
            artifacts.push(id);
            detail.run.artifactBytes =
              (detail.run.artifactBytes ?? 0) + bytes.length;
            result = {
              type: "image",
              artifact: id,
              mimeType: item.mimeType ?? "image/png",
            };
          }
          images.set(item.data, result);
          return result;
        }
        if (Array.isArray(item)) {
          const result = [];
          for (const child of item.slice(0, 1000))
            result.push(await visit(child, depth + 1));
          if (item.length > 1000)
            result.push({
              truncated: true,
              omittedItems: item.length - 1000,
              notice: "Array item limit reached.",
            });
          return result;
        }
        const entries = Object.entries(item);
        const result: Record<string, unknown> = {};
        for (const [key, child] of entries.slice(0, 1000))
          Object.defineProperty(result, key, {
            value: await visit(child, depth + 1),
            enumerable: true,
          });
        if (entries.length > 1000)
          result.__retention = {
            truncated: true,
            omittedProperties: entries.length - 1000,
          };
        return result;
      };
      const sanitized = await visit(value);
      // Plain-text duplicates can occur before the corresponding structured image.
      let json = JSON.stringify(sanitized ?? null);
      for (const data of images.keys())
        if (data.length)
          json = json
            .split(JSON.stringify(data).slice(1, -1))
            .join("[Image data omitted; see retained artifact.]");
      return bounded(JSON.parse(json));
    });
  }
  async flush() {
    await this.chain;
  }
}
