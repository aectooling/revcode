import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunHistory, bounded } from "../../src/host/history.js";
import {
  HISTORY_LIMITS,
  type RunDetail,
} from "../../src/host/history-types.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "revcode-runs-"));
  folders.push(dir);
  return { dir, history: await RunHistory.open(dir) };
}
function detail(
  number: number,
  status: RunDetail["run"]["status"] = "finished",
): RunDetail {
  return {
    run: {
      id: `run-${number}`,
      instanceId: "instance",
      number,
      requestId: `request-${number}`,
      userMessageId: `user-${number}`,
      assistantMessageId: `assistant-${number}`,
      promptPreview: `Work ${number}`,
      startedAt: new Date().toISOString(),
      status,
      intent: "work",
      mode: "execution",
      sourceRunIds: [],
      provider: "test",
      model: "model",
      toolNames: [],
      failedCalls: 0,
      callCount: 0,
      detailsAvailable: true,
    },
    calls: [],
    messages: [
      {
        id: `user-${number}`,
        role: "user",
        text: `Work ${number}`,
        runId: `run-${number}`,
      },
    ],
    operations: [],
  };
}
describe("durable run history", () => {
  it("keeps large message images across restart and prunes them with their run", async () => {
    const { history, dir } = await fixture();
    const run = detail(1);
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    run.messages[0].images = await history.result([{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }], run, []) as typeof run.messages[0].images;
    await history.save(run);
    const artifact = run.messages[0].images![0].artifact!;
    expect(run.run.detailBytes).toBeLessThan(10000);
    expect(run.run.artifactBytes).toBe(bytes.length);
    const reopened = await RunHistory.open(dir);
    expect(await reopened.image(artifact)).toEqual(bytes);
    expect((await reopened.detail(run.run.id)).messages[0].images).toEqual(run.messages[0].images);
    reopened.summaries.get(run.run.id)!.artifactBytes = HISTORY_LIMITS.aggregateArtifactBytes;
    await reopened.prune();
    await expect(reopened.image(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(reopened.list().runs[0].detailsAvailable).toBe(false);
  });

  it.each(["finished", "failed"] as const)("recovers a published %s detail over a stale running summary", async (status) => {
    const { history, dir } = await fixture();
    const run = detail(1, "running");
    await history.save(run);
    const summaryPath = join(dir, "run-1.summary.json");
    const staleSummary = await readFile(summaryPath, "utf8");
    run.run.status = status;
    run.run.endedAt = "2026-09-15T04:00:00.000Z";
    await history.save(run);
    // Simulate a crash after detail publication but before summary publication.
    await writeFile(summaryPath, staleSummary);
    const reopened = await RunHistory.open(dir);
    expect((await reopened.detail(run.run.id)).run).toEqual(run.run);
    expect(JSON.parse(await readFile(summaryPath, "utf8"))).toEqual(run.run);
    expect((await RunHistory.open(dir)).list().runs[0].status).toBe(status);
  });
  it("does not resurrect details after a summary-first retention crash", async () => {
    const { history, dir } = await fixture();
    const run = detail(1);
    await history.save(run);
    await writeFile(join(dir, "run-1.summary.json"), JSON.stringify({ ...run.run, detailsAvailable: false }));
    const reopened = await RunHistory.open(dir);
    expect((await reopened.detail(run.run.id)).run.detailsAvailable).toBe(false);
    expect(await readdir(dir)).not.toContain("run-1.detail.json");
  });
  it("keeps cursor pages stable when a new run arrives and searches all retained summaries", async () => {
    const { history } = await fixture();
    for (let n = 1; n <= 8; n++) await history.save(detail(n));
    const first = history.list({ limit: 3 });
    expect(first.runs.map((r) => r.number)).toEqual([8, 7, 6]);
    await history.save(detail(9));
    expect(
      history
        .list({ limit: 3, cursor: first.nextCursor })
        .runs.map((r) => r.number),
    ).toEqual([5, 4, 3]);
    expect(history.list({ search: "Work 1" }).runs[0]?.number).toBe(1);
    expect((await history.detail("run-1")).messages[0].text).toBe("Work 1");
  });
  it("marks pending tools and operations unknown on restart without altering confirmed receipts", async () => {
    const { dir, history } = await fixture();
    const run = detail(1, "running");
    run.calls.push({
      id: "call",
      runId: run.run.id,
      name: "capture",
      sequence: 1,
      arguments: {},
      startedAt: "",
      status: "running",
      operationIds: ["op"],
      artifacts: [],
    });
    run.operations.push({
      operationId: "op",
      mode: "query",
      code: "return 1;",
      documentToken: "historical",
      createdAt: "",
      status: "succeeded",
      result: 1,
    });
    await history.save(run);
    const reopened = await RunHistory.open(dir);
    const restored = await reopened.detail(run.run.id);
    expect(restored.run.status).toBe("interrupted");
    expect(restored.calls[0].status).toBe("unknown");
    expect(restored.operations[0]).toMatchObject({
      status: "succeeded",
      result: 1,
    });
    expect(
      reopened.list({ errorsOnly: true, tool: "capture" }).runs,
    ).toHaveLength(1);
  });
  it("prunes completed payloads separately while preserving summaries and protected sources", async () => {
    const { history, dir } = await fixture();
    for (let n = 1; n <= 3; n++) {
      const run = detail(n);
      await history.save(run);
      history.summaries.get(run.run.id)!.detailBytes =
        HISTORY_LIMITS.aggregateTextBytes / 2;
    }
    history.protected.add("run-1");
    await history.prune();
    expect((await history.detail("run-1")).messages).toHaveLength(1);
    expect((await history.detail("run-2")).missingEvidence?.[0]).toContain(
      "expired",
    );
    expect(history.list().runs).toHaveLength(3);
    await expect(
      readFile(join(dir, "run-2.detail.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("stores image bytes before references and bounds textual results", async () => {
    const { history, dir } = await fixture();
    const run = detail(1);
    const artifacts: string[] = [];
    const result = await history.result(
      {
        content: [
          {
            type: "image",
            data: Buffer.from("test image bytes").toString("base64"),
            mimeType: "image/png",
          },
        ],
      },
      run,
      artifacts,
    );
    expect(JSON.stringify(result)).not.toContain("dGVzdCBpbWFnZSBieXRlcw==");
    expect(artifacts).toHaveLength(1);
    expect(await readFile(join(dir, "artifacts", artifacts[0]), "utf8")).toBe(
      "test image bytes",
    );
    expect(bounded("x".repeat(100), 80)).toMatchObject({ truncated: true });
    expect(() => history.image("../journal.json")).toThrow();
  });
  it("removes duplicate image data from SDK JSON text, details and plain text and stores one artifact", async () => {
    const { history } = await fixture();
    const run = detail(1);
    const artifacts: string[] = [];
    const data = Buffer.from("private screenshot bytes").toString("base64");
    const image = { type: "image", data, mimeType: "image/png" };
    const result = await history.result(
      {
        content: [
          { type: "text", text: JSON.stringify({ screenshot: image }) },
          image,
        ],
        details: image,
        log: `received ${data}`,
      },
      run,
      artifacts,
    );
    expect(JSON.stringify(result)).not.toContain(data);
    expect(artifacts).toHaveLength(1);
    expect(JSON.stringify(result)).toContain(artifacts[0]);
  });
  it("reports array omissions and bounds JSON-escaped multibyte previews by actual bytes", async () => {
    const { history } = await fixture();
    const result = (await history.result(
      Array.from({ length: 1003 }, (_, i) => i),
      detail(1),
      [],
    )) as unknown[];
    expect(result.at(-1)).toMatchObject({ truncated: true, omittedItems: 3 });
    for (const input of ['"\\\n'.repeat(1000), "😀漢字".repeat(1000)]) {
      const value = bounded(input, 300);
      expect(value).toMatchObject({ truncated: true });
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(300);
    }
  });
  it("reserves image bytes across parallel result capture before any run is saved", async () => {
    const { history } = await fixture();
    const run = detail(1);
    const artifacts: string[] = [];
    const limits = HISTORY_LIMITS as unknown as {
      aggregateArtifactBytes: number;
    };
    const original = limits.aggregateArtifactBytes;
    limits.aggregateArtifactBytes = 12;
    try {
      const results = await Promise.all(
        ["12345678", "abcdefgh"].map((text) =>
          history.result(
            { type: "image", data: Buffer.from(text).toString("base64") },
            run,
            artifacts,
          ),
        ),
      );
      expect(artifacts).toHaveLength(1);
      expect(results[1]).toMatchObject({
        unavailable: "Image storage budget exhausted.",
      });
    } finally {
      limits.aggregateArtifactBytes = original;
    }
  });
  it("recovers unpublished run summaries before collecting orphan artifacts and interrupted temporary files", async () => {
    const { dir, history } = await fixture();
    const run = detail(1, "running");
    const artifacts: string[] = [];
    const result = await history.result(
      { type: "image", data: Buffer.from("retained bytes").toString("base64") },
      run,
      artifacts,
    );
    run.calls.push({
      id: "call",
      runId: run.run.id,
      name: "capture",
      sequence: 1,
      arguments: {},
      startedAt: "",
      status: "succeeded",
      result,
      artifacts,
      operationIds: [],
    });
    await history.save(run);
    await rm(join(dir, "run-1.summary.json"));
    await writeFile(join(dir, "artifacts", "orphan.png"), "orphan");
    await writeFile(join(dir, "artifacts", "pending.png.abc.tmp"), "partial");
    await writeFile(join(dir, "run-1.detail.json.abc.tmp"), "partial");
    const reopened = await RunHistory.open(dir);
    expect((await reopened.detail(run.run.id)).run.status).toBe("interrupted");
    expect((await reopened.image(artifacts[0])).toString()).toBe(
      "retained bytes",
    );
    expect(await readdir(join(dir, "artifacts"))).toEqual(artifacts);
    expect(await readdir(dir)).not.toContain("run-1.detail.json.abc.tmp");
    expect(reopened.nextNumber).toBe(2);
  });
  it("serializes retention after lifecycle updates and protects unfinished receipts regardless of run completion", async () => {
    const { history, dir } = await fixture();
    const run = detail(1);
    run.calls.push({
      id: "call",
      runId: run.run.id,
      name: "capture",
      sequence: 1,
      arguments: {},
      startedAt: "",
      status: "running",
      artifacts: [],
      operationIds: [],
    });
    await history.save(run);
    history.summaries.get(run.run.id)!.detailBytes =
      HISTORY_LIMITS.aggregateTextBytes;
    await expect(history.prepare()).rejects.toThrow("protected evidence");
    const reopened = await RunHistory.open(dir);
    expect((await reopened.detail(run.run.id)).calls[0].status).toBe("unknown");
    const another = detail(2, "running");
    await Promise.all([reopened.save(another), reopened.prune()]);
    expect((await reopened.detail(another.run.id)).run.detailsAvailable).toBe(
      true,
    );
  });
  it("rolls back only unaccepted empty runs and retains searchable full prompts behind bounded summaries", async () => {
    const { history, dir } = await fixture();
    const pending = detail(1, "running");
    await history.save(pending);
    await history.discardUnaccepted(pending.run.id);
    expect(history.list().runs).toHaveLength(0);
    expect(await readdir(dir)).not.toContain("run-1.detail.json");
    const completed = detail(2);
    completed.run.promptPreview = "x".repeat(1000) + "searchable ending";
    await history.save(completed);
    await expect(history.discardUnaccepted(completed.run.id)).rejects.toThrow(
      "Cannot discard",
    );
    expect(
      history.list({ search: "searchable ending" }).runs[0].promptPreview,
    ).toHaveLength(240);
    expect(
      (await history.detail(completed.run.id)).run.promptPreview,
    ).toContain("searchable ending");
  });
  it("keeps possibly referenced artifact evidence when a retained detail file is missing", async () => {
    const { history, dir } = await fixture();
    const run = detail(1);
    await history.save(run);
    await writeFile(
      join(dir, "artifacts", "possibly-retained.png"),
      "evidence",
    );
    await rm(join(dir, "run-1.detail.json"));
    const reopened = await RunHistory.open(dir);
    expect((await reopened.detail(run.run.id)).missingEvidence).toContain(
      "Recorded detail file is unavailable.",
    );
    expect((await reopened.image("possibly-retained.png")).toString()).toBe(
      "evidence",
    );
  });
});
