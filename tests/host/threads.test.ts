import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    api,
    state,
    idle,
    restart: async () => {
      await idle();
      await host.close();
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
