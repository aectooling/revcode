import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../../src/host/server.js";
import type { Agent, Message } from "../../src/host/types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  prompt: Agent["prompt"] = async (_t, _s, _c, _h, _e, update) =>
    update("Saved reply"),
  messages?: Message[],
) {
  const dir = await mkdtemp(join(tmpdir(), "revcode-threads-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  if (messages)
    await writeFile(
      join(dir, "journal.json"),
      JSON.stringify({
        version: 2,
        messages,
        operations: [],
        requests: {},
        settings: { provider: "test", model: "test", configured: true },
      }),
    );
  const agent: Agent = {
    providers: [{ id: "anthropic", models: [{ id: "test", name: "Test" }] }],
    configured: () => true,
    setKey: async () => {},
    abort: async () => {},
    prompt,
  };
  const options = {
    instanceId: "thread-test",
    nativeToken: "test",
    dataDir: dir,
    webDir: dir,
    agent,
  };
  let host = await createHost(options);
  cleanups.push(() => host.close());
  const api = (path: string, data?: unknown) =>
    fetch(`${host.url}/api/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${host.browserToken}`,
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const state = async (id: string) =>
    (await api(`state?threadId=${id}`)).json();
  const idle = () => expect.poll(() => host.snapshot().chatBusy).toBe(false);
  return {
    dir,
    api,
    state,
    idle,
    restart: async (beforeOpen?: () => Promise<void>) => {
      await idle();
      await host.close();
      await beforeOpen?.();
      host = await createHost(options);
    },
  };
}

it("isolates agent context and run history, preserving threads across restart", async () => {
  const contexts: Message[][] = [];
  const f = await fixture(async (_t, _s, _c, history, _e, update) => {
    contexts.push(history);
    update("Saved reply");
  });
  const a = await (
    await f.api("threads", { requestId: "create-thread-a" })
  ).json();
  const retry = await (
    await f.api("threads", { requestId: "create-thread-a" })
  ).json();
  expect(retry.id).toBe(a.id);
  const b = await (
    await f.api("threads", { requestId: "create-thread-b" })
  ).json();
  for (const [id, text, requestId] of [
    [a.id, "First thread topic", "message-a-first"],
    [b.id, "Second thread topic", "message-b-first"],
    [a.id, "Follow up", "message-a-second"],
  ]) {
    expect(
      (
        await f.api("chat", {
          threadId: id,
          text,
          requestId,
          mode: "authoring",
        })
      ).status,
    ).toBe(202);
    await f.idle();
  }
  expect(contexts.map((h) => h.map((m) => m.text))).toEqual([
    [],
    [],
    ["First thread topic", "Saved reply"],
  ]);
  const page = await (await f.api(`runs?threadId=${b.id}`)).json();
  expect(page.runs).toHaveLength(1);
  expect(page.runs[0].threadId).toBe(b.id);
  await f.restart();
  expect((await f.state(a.id)).messages.map((m: Message) => m.text)).toEqual([
    "First thread topic",
    "Saved reply",
    "Follow up",
    "Saved reply",
  ]);
  expect((await f.state(b.id)).messages.map((m: Message) => m.text)).toEqual([
    "Second thread topic",
    "Saved reply",
  ]);
  expect(
    (await f.state(a.id)).threads.find((t: { id: string }) => t.id === a.id)
      .title,
  ).toBe("First thread topic");
});

it("keeps archived transcripts readable, blocks new work, and restores them", async () => {
  const f = await fixture();
  const payload = {
    threadId: "legacy",
    text: "Saved conversation",
    mode: "authoring",
    requestId: "archive-message",
  };
  expect((await f.api("chat", payload)).status).toBe(202);
  await f.idle();
  expect(
    (await f.api("threads/archive", { threadId: "legacy", archived: true }))
      .status,
  ).toBe(200);
  await f.restart();
  expect((await f.state("legacy")).messages).toHaveLength(2);
  expect((await f.api("chat", payload)).status).toBe(202); // Retry never executes again.
  expect(
    (await f.api("chat", { ...payload, requestId: "archived-new-message" }))
      .status,
  ).toBe(409);
  expect(
    (await f.api("threads/archive", { threadId: "legacy", archived: false }))
      .status,
  ).toBe(200);
  expect(
    (await f.api("chat", { ...payload, requestId: "restored-message" })).status,
  ).toBe(202);
  await f.idle();
  expect((await f.state("legacy")).messages).toHaveLength(4);
});

it("allows browsing and creating threads during work without releasing the global slot", async () => {
  let finish!: () => void;
  const f = await fixture(
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(
    (
      await f.api("chat", {
        text: "Working",
        mode: "authoring",
        requestId: "running-message",
      })
    ).status,
  ).toBe(202);
  try {
    expect((await f.state("legacy")).activeThreadId).toBe("legacy");
    expect(
      (await f.api("threads/archive", { threadId: "legacy", archived: true }))
        .status,
    ).toBe(409);
    const other = await (
      await f.api("threads", { requestId: "create-during-run" })
    ).json();
    expect((await f.state(other.id)).messages).toEqual([]);
    expect(
      (
        await f.api("chat", {
          threadId: other.id,
          text: "Concurrent",
          mode: "authoring",
          requestId: "concurrent-message",
        })
      ).status,
    ).toBe(409);
  } finally {
    finish();
    await f.idle();
  }
});

it("migrates existing messages and pages older history without mixing threads", async () => {
  const messages: Message[] = Array.from({ length: 205 }, (_, i) => ({
    id: `old-${i}`,
    role: "user",
    text: `Message ${i}`,
  }));
  const f = await fixture(undefined, messages);
  const state = await f.state("legacy");
  expect(state.messages).toHaveLength(200);
  expect(state.hasOlderMessages).toBe(true);
  const page = await (
    await f.api(
      `threads/messages?threadId=legacy&before=${state.messages[0].id}`,
    )
  ).json();
  expect(page.messages).toEqual(messages.slice(0, 5));
  expect(page.hasOlderMessages).toBe(false);
  expect(
    (
      await f.api("chat", {
        threadId: "missing",
        text: "No",
        mode: "authoring",
        requestId: "missing-thread",
      })
    ).status,
  ).toBe(404);
});


it("permanently deletes a completed thread and its runs without affecting another thread", async () => {
  const f = await fixture();
  const other = await (await f.api("threads", { requestId: "delete-kept-thread" })).json();
  for (const id of ["legacy", other.id]) {
    expect((await f.api("chat", { threadId: id, text: `Saved ${id}`, requestId: `delete-message-${id}`, mode: "authoring" })).status).toBe(202);
    await f.idle();
  }
  const before = await f.state("legacy");
  expect(before.historyStorage.journalPath).toBe(join(f.dir, "journal.json"));
  const runId = before.runs[0].id;
  const detailPath = join(f.dir, "runs", `${runId}.detail.json`);
  const detail = JSON.parse(await readFile(detailPath, "utf8"));
  detail.messages[0].images = [{ artifact: "delete-me.png", mimeType: "image/png" }];
  await writeFile(join(f.dir, "runs", "artifacts", "delete-me.png"), "fixture image");
  await writeFile(detailPath, JSON.stringify(detail));
  expect((await f.api("threads/delete", { threadIds: ["legacy"] })).status).toBe(200);
  expect((await f.api(`runs/${runId}`)).status).toBe(404);
  expect(await readdir(join(f.dir, "runs", "artifacts"))).not.toContain("delete-me.png");
  expect((await readdir(join(f.dir, "runs"))).some(name => name.startsWith(runId))).toBe(false);
  await f.restart();
  const after = await f.state("legacy");
  expect(after.selectedThreadId).toBe(other.id);
  expect(after.threads.map((thread: { id: string }) => thread.id)).toEqual([other.id]);
  expect(after.messages.map((message: Message) => message.text)).toEqual([`Saved ${other.id}`, "Saved reply"]);
  expect((await f.api("threads/delete", { threadIds: [other.id] })).status).toBe(200);
  await f.restart();
  const empty = await f.state(other.id);
  expect(empty.threads).toHaveLength(1);
  expect(empty.selectedThreadId).not.toBe(other.id);
  expect(empty.messages).toEqual([]);
});

it("validates the entire archived deletion selection before deleting anything", async () => {
  const f = await fixture();
  const other = await (await f.api("threads", { requestId: "purge-kept-thread" })).json();
  await f.api("threads/archive", { threadId: "legacy", archived: true });
  expect((await f.api("threads/delete", { threadIds: ["legacy", other.id], archivedOnly: true, before: null })).status).toBe(409);
  expect((await f.state("legacy")).threads).toHaveLength(2);
  expect((await f.api("threads/delete", { threadIds: ["legacy"], archivedOnly: true, before: 0 })).status).toBe(409);
  expect((await f.api("threads/delete", { threadIds: ["legacy"], archivedOnly: true, before: Date.now() + 1000 })).status).toBe(200);
});

it("rejects deleting a running thread", async () => {
  let finish!: () => void;
  const f = await fixture(async () => { await new Promise<void>(resolve => { finish = resolve; }); });
  try {
    await f.api("chat", { threadId: "legacy", text: "Wait", requestId: "delete-running-message", mode: "authoring" });
    await expect.poll(() => typeof finish).toBe("function");
    expect((await f.api("threads/delete", { threadIds: ["legacy"] })).status).toBe(409);
    expect((await f.state("legacy")).threads).toHaveLength(1);
  } finally { finish?.(); await f.idle(); }
});


it("completes persisted deletion intent before restoring saved transcripts", async () => {
  const f = await fixture();
  const kept = await (await f.api("threads", { requestId: "recovery-kept-thread" })).json();
  await f.api("chat", { threadId: "legacy", text: "Remove after interrupted deletion", requestId: "recovery-delete-message", mode: "authoring" });
  await f.idle();
  const runId = (await f.state("legacy")).runs[0].id;
  await f.restart(async () => {
    const path = join(f.dir, "journal.json");
    const journal = JSON.parse(await readFile(path, "utf8"));
    journal.deletedThreadIds = ["legacy"];
    journal.threads = journal.threads.filter((thread: { id: string }) => thread.id !== "legacy");
    await writeFile(path, JSON.stringify(journal));
  });
  const state = await f.state("legacy");
  expect(state.selectedThreadId).toBe(kept.id);
  expect(state.messages).toEqual([]);
  expect((await f.api(`runs/${runId}`)).status).toBe(404);
});


it("excludes unresolved native outcomes from thread deletion and exposes that protection", async () => {
  const f = await fixture();
  await f.api("chat", { threadId: "legacy", text: "Recorded work", requestId: "delete-unknown-outcome", mode: "authoring" });
  await f.idle();
  const runId = (await f.state("legacy")).runs[0].id;
  await f.restart(async () => {
    const path = join(f.dir, "runs", `${runId}.detail.json`);
    const detail = JSON.parse(await readFile(path, "utf8"));
    detail.operations.push({ operationId: "unknown-operation", runId, mode: "query", code: "return null;", documentToken: null, createdAt: new Date().toISOString(), status: "unknown" });
    await writeFile(path, JSON.stringify(detail));
  });
  expect((await f.state("legacy")).protectedThreadIds).toContain("legacy");
  expect((await f.api("threads/delete", { threadIds: ["legacy"] })).status).toBe(409);
});
