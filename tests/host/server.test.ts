import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dealer } from "zeromq";
import { createHost } from "../../src/host/server.js";
import type { Agent } from "../../src/host/types.js";
import type { DesktopTransport } from "../../src/host/desktop-types.js";

const persistence = vi.hoisted(() => ({
  gate: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).endsWith("journal.json.tmp"))
        await persistence.gate?.();
      return actual.writeFile(...args);
    },
  };
});

const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});
const context = {
  instanceId: "test-instance",
  revitVersion: "2026",
  revitBuild: "26.3",
  runtime: ".NET 8",
  document: {
    token: "doc-1",
    title: "Test",
    isFamily: false,
    isReadOnly: false,
    activeView: "Level 1",
    selection: [],
  },
};
function desktopFixture() {
  let captures = 0,
    stops = 0;
  const transport: DesktopTransport = {
    request: async (kind) => {
      if (kind === "observe")
        return {
          observationId: (++captures).toString(16).padStart(32, "0"),
          windowRef: "a".repeat(32),
          title: "Revit",
          timestamp: new Date().toISOString(),
          width: 1,
          height: 1,
          dpi: 96,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          crop: { x: 0, y: 0, width: 1, height: 1 },
          windows: [],
          actionable: true,
          backend: "fixture",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=",
        };
      if (kind === "action")
        return { status: "unknown", inserted: 1, error: "Partial input" };
      return { status: "owned" };
    },
    stop: async () => {
      stops++;
    },
    close: async () => {},
  };
  return { transport, stops: () => stops };
}
async function setup(
  overrides: Partial<Agent> = {},
  heartbeatMs = 10000,
  desktop?: DesktopTransport,
) {
  const dir = await mkdtemp(join(tmpdir(), "revcode-host-"));
  resources.push(() => rm(dir, { recursive: true, force: true }));
  const agent: Agent = {
    providers: [
      { id: "anthropic", models: [{ id: "test-model", name: "Test" }] },
    ],
    configured: () => true,
    setKey: async () => {},
    abort: async () => {},
    prompt: async () => {},
    ...overrides,
  };
  const host = await createHost({
    instanceId: "test-instance",
    nativeToken: "native-secret",
    dataDir: dir,
    webDir: dir,
    agent,
    heartbeatMs,
    desktop,
    desktopTiming: {
      countdownMs: 0,
      recoveryDelayMs: 0,
      inputPollMs: 0,
      inputAttempts: 3,
    },
  });
  resources.push(() => host.close());
  const dealer = new Dealer({ receiveTimeout: 2000, linger: 0 });
  dealer.connect(host.nativeEndpoint);
  resources.push(async () => dealer.close());
  const native = async (
    type: string,
    payload?: unknown,
    token = "native-secret",
  ) => dealer.send(JSON.stringify({ type, token, payload }));
  const api = async (path: string, data?: unknown, token = host.browserToken) =>
    fetch(host.url + "/api/" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  await native("context", context);
  await expect.poll(() => host.snapshot().connected).toBe(true);
  return { host, dealer, native, api, dir };
}

describe("authenticated Revit host", () => {
  it("migrates old history losslessly without guessed run links or repeated payload rewrites", async () => {
    const dir = await mkdtemp(join(tmpdir(), "revcode-migration-"));
    resources.push(() => rm(dir, { recursive: true, force: true }));
    const legacy = {
      messages: [{ id: "old-message", role: "user", text: "Legacy prompt" }],
      operations: [
        {
          operationId: "old-operation",
          documentToken: null,
          code: "return 7;",
          mode: "query",
          status: "succeeded",
          result: 7,
          createdAt: "2025-01-01",
        },
      ],
      requests: {
        "legacy-request": {
          fingerprint: "saved",
          response: { operationId: "old-operation" },
        },
      },
      settings: {
        provider: "anthropic",
        model: "old-model",
        configured: false,
      },
    };
    await writeFile(join(dir, "journal.json"), JSON.stringify(legacy));
    const host = await createHost({
      instanceId: "migration",
      dataDir: dir,
      webDir: dir,
      nativeToken: "test",
      agent: {
        providers: [],
        configured: () => false,
        setKey: async () => {},
        prompt: async () => {},
        abort: async () => {},
      },
    });
    resources.push(() => host.close());
    expect(host.snapshot().messages).toEqual(legacy.messages);
    expect(host.snapshot().operations).toEqual(legacy.operations);
    expect(host.snapshot().runs).toEqual([]);
    const saved = JSON.parse(await readFile(join(dir, "journal.json"), "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.messages).toEqual([]);
    expect(saved.operations).toEqual([]);
    expect(saved.requests).toEqual(legacy.requests);
    expect(saved.settings).toEqual(legacy.settings);
    expect(
      JSON.parse(await readFile(join(dir, "legacy-history.json"), "utf8")),
    ).toEqual({ messages: legacy.messages, operations: legacy.operations });
  });
  it("associates internal native operations to the originating tool and records the actual document", async () => {
    const { api, dealer, native, host } = await setup({
      prompt: async (_t, _s, _c, _h, execute, _u, _desktop, services) => {
        await services!.onToolEvent!({
          type: "start",
          id: "capture-parent",
          name: "revit_capture_view",
          arguments: {},
        });
        const result = await services!.withToolCall!("capture-parent", () =>
          execute({ mode: "query", code: "return 1;" }),
        );
        await services!.onToolEvent!({
          type: "end",
          id: "capture-parent",
          name: "revit_capture_view",
          result,
        });
      },
    });
    const accepted = await (
      await api("chat", { requestId: "correlation-001", text: "Capture model" })
    ).json();
    const [frame] = await dealer.receive();
    const operationId = JSON.parse(frame.toString()).command.operationId;
    await native("operation", { operationId, status: "succeeded", result: 1 });
    await expect.poll(() => host.snapshot().chatBusy).toBe(false);
    const detail = await (await api(`runs/${accepted.runId}`)).json();
    expect(detail.calls).toHaveLength(1);
    expect(detail.calls[0].operationIds).toEqual([operationId]);
    expect(detail.operations[0]).toMatchObject({
      runId: accepted.runId,
      toolCallId: "capture-parent",
      documentToken: "doc-1",
      documentTitle: "Test",
      documentKind: "project",
      historicalDocumentReference: true,
    });
  });
  it("resolves explicit source runs chronologically and defaults past authoring runs", async () => {
    const sources: string[][] = [];
    const { api, host } = await setup({
      prompt: async (_t, _s, _c, _h, _e, _u, _d, services) => {
        sources.push(services?.sourceRunReferences?.map((r) => r.runId) ?? []);
      },
    });
    const submit = async (id: string, text: string, extra = {}) => {
      const response = await (
        await api("chat", { requestId: id, text, ...extra })
      ).json();
      await expect.poll(() => host.snapshot().chatBusy).toBe(false);
      return response.runId as string;
    };
    const first = await submit("source-work-001", "Inspect model");
    await submit("source-author-001", "Write notes", { mode: "authoring" });
    const second = await submit("source-work-002", "Verify model");
    await submit("source-author-002", "Make a skill from this run");
    expect(sources.at(-1)).toEqual([second]);
    await submit("source-author-003", "Make a reusable skill", {
      sourceRunIds: [second, first],
    });
    expect(sources.at(-1)).toEqual([first, second]);
    expect(
      (
        await api("chat", {
          requestId: "source-missing-001",
          mode: "authoring",
          text: "Make a skill",
          sourceRunIds: ["missing"],
        })
      ).status,
    ).toBe(409);
  });
  it("records one run on retries, correlates tools and keeps completed payloads outside the live journal", async () => {
    const { api, host, dir } = await setup({
      prompt: async (_t, _s, _c, _h, _execute, update, _desktop, services) => {
        await services!.onToolEvent!({
          type: "start",
          id: "call-1",
          name: "read",
          arguments: { path: "skill" },
        });
        await services!.onToolEvent!({
          type: "end",
          id: "call-1",
          name: "read",
          result: { error: "Unavailable" },
          isError: true,
        });
        update("Finished with a failed read.");
      },
    });
    const request = {
      requestId: "durable-run-001",
      text: "Inspect recorded work",
    };
    const accepted = await (await api("chat", request)).json();
    await expect.poll(() => host.snapshot().chatBusy).toBe(false);
    expect(await (await api("chat", request)).json()).toEqual(accepted);
    const page = await (await api("runs?errorsOnly=true&tool=read")).json();
    expect(page.runs).toHaveLength(1);
    const detail = await (await api(`runs/${accepted.runId}`)).json();
    expect(detail.run).toMatchObject({ status: "finished", failedCalls: 1 });
    expect(detail.messages.map((m: any) => m.runId)).toEqual([
      accepted.runId,
      accepted.runId,
    ]);
    const journal = JSON.parse(
      await readFile(join(dir, "journal.json"), "utf8"),
    );
    expect(journal.messages).toHaveLength(0);
    expect(journal.requests[request.requestId].response).toEqual(accepted);
    expect((await api(`runs/${accepted.runId}`, undefined, "bad")).status).toBe(
      401,
    );
  });
  it("allows restricted authoring while disconnected without clearing unknown native receipts", async () => {
    let mode: string | undefined,
      desktopAvailable = true;
    const { api, native, dealer, host } = await setup({
      prompt: async (_t, _s, _c, _h, execute, update, desktop, services) => {
        mode = services?.mode;
        desktopAvailable = !!desktop;
        await expect(
          execute({ mode: "query", code: "return 1;" }),
        ).rejects.toThrow("unavailable");
        update("Authored.");
      },
    });
    const accepted = await (
      await api("execute", {
        requestId: "unknown-before-author",
        mode: "api",
        code: "return 1;",
      })
    ).json();
    await dealer.receive();
    await native("operation", {
      operationId: accepted.operationId,
      status: "unknown",
    });
    await expect
      .poll(() => host.snapshot().operations[0].status)
      .toBe("unknown");
    await native("disconnect");
    await expect.poll(() => host.snapshot().connected).toBe(false);
    expect(
      (
        await api("chat", {
          requestId: "author-offline-1",
          mode: "authoring",
          text: "Write reusable instructions",
        })
      ).status,
    ).toBe(202);
    await expect.poll(() => host.snapshot().chatBusy).toBe(false);
    expect(mode).toBe("authoring");
    expect(desktopAvailable).toBe(false);
    expect(host.snapshot().operations[0].status).toBe("unknown");
    expect(
      (
        await api("chat", {
          requestId: "execution-offline-1",
          text: "Inspect the model",
        })
      ).status,
    ).toBe(409);
  });
  it("rejects stale skill selection before accepting a run and persists drafts separately", async () => {
    const { api, host, dir } = await setup();
    expect(
      (
        await api("chat", {
          requestId: "stale-selection-1",
          text: "Use a skill",
          selectedSkillIds: ["missing"],
        })
      ).status,
    ).toBe(409);
    expect(host.snapshot().runs).toHaveLength(0);
    const draft = {
      version: 1,
      code: "return 42;",
      mode: "query",
      steps: [],
      verify: "",
      documentToken: "doc-1",
      sessionId: null,
    };
    expect((await api("console-draft", draft)).status).toBe(200);
    expect(await (await api("console-draft")).json()).toEqual({ draft });
    expect((await api("console-draft", { ...draft, code: 42 })).status).toBe(
      400,
    );
    expect(await readFile(join(dir, "console-draft.json"), "utf8")).toContain(
      "return 42;",
    );
    expect(host.snapshot().operations).toHaveLength(0);
  });
  it.each(["reject", "resolve"])(
    "reports the desktop interruption when the SDK %ss after abort",
    async (completion) => {
      const fixture = desktopFixture();
      let finishPrompt: (() => void) | undefined;
      const { host, api } = await setup(
        {
          prompt: async (
            _text,
            _settings,
            _context,
            _history,
            _execute,
            _update,
            desktop,
          ) => {
            await desktop!.observe({});
            await new Promise<void>((resolve, reject) => {
              finishPrompt = () =>
                completion === "resolve"
                  ? resolve()
                  : reject(new Error("Request was aborted"));
            });
          },
          abort: async () => {
            finishPrompt?.();
          },
        },
        10000,
        fixture.transport,
      );
      expect(
        (
          await api("chat", {
            requestId: "desktop-interruption",
            text: "Inspect Revit",
          })
        ).status,
      ).toBe(202);
      await expect.poll(() => !!finishPrompt).toBe(true);
      fixture.transport.onState?.({
        owned: false,
        unknown: false,
        error: "Desktop control paused: focus moved outside Revit.",
      });
      await expect
        .poll(() => host.snapshot().messages.at(-1)?.text)
        .toContain("focus moved outside Revit");
      expect(host.snapshot().messages.at(-1)?.text).not.toContain(
        "Request was aborted",
      );
    },
  );

  it.each(["chat", "execute"])(
    "Stop cancels %s while its acceptance journal write is suspended",
    async (path) => {
      let prompts = 0;
      const { api, host, dealer } = await setup({
        prompt: async () => {
          prompts++;
        },
      });
      let entered = false;
      let release!: () => void;
      persistence.gate = async () => {
        persistence.gate = undefined;
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      const submission = api(
        path,
        path === "chat"
          ? {
              requestId: "stop-acceptance-chat",
              text: "Do not run after Stop.",
            }
          : {
              requestId: "stop-acceptance-api",
              mode: "query",
              code: "return 1;",
            },
      );
      try {
        await expect.poll(() => entered).toBe(true);
        expect((await api("cancel", {})).status).toBe(200);
      } finally {
        persistence.gate = undefined;
        release?.();
      }
      expect((await submission).status).toBe(202);
      await expect.poll(() => host.snapshot().busy).toBe(false);
      expect(prompts).toBe(0);
      if (path === "execute") {
        expect(host.snapshot().operations[0].status).toBe("cancelled");
        const [frame] = await dealer.receive();
        expect(JSON.parse(frame.toString()).command.kind).toBe("cancel");
      } else
        expect(host.snapshot().messages.at(-1)?.text).toContain("Cancelled");
    },
  );

  it("exposes authenticated passive desktop capture despite an unknown native outcome", async () => {
    const fixture = desktopFixture();
    const { api, dealer, native, host } = await setup(
      {},
      10000,
      fixture.transport,
    );
    const result = await (
      await api("execute", {
        requestId: "native-unknown-001",
        mode: "api",
        code: "return true;",
      })
    ).json();
    await dealer.receive();
    await native("operation", {
      operationId: result.operationId,
      status: "unknown",
    });
    await expect
      .poll(() => host.snapshot().operations[0].status)
      .toBe("unknown");
    expect((await api("desktop/observe", {}, "wrong-token")).status).toBe(401);
    const screenshot = await api("desktop/observe", {});
    expect(screenshot.status).toBe(200);
    expect((await screenshot.json()).actionable).toBe(false);
    const artifact = host.snapshot().desktop.latest!.artifact;
    expect(
      (await api(`desktop/image/${artifact}`, undefined, "wrong-token")).status,
    ).toBe(401);
    const image = await api(`desktop/image/${artifact}`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(host.snapshot().operations[0].status).toBe("unknown");
  });

  it("passes desktop tools to chat and fences native edits after uncertain desktop input", async () => {
    let actionCompleted = false;
    const fixture = desktopFixture();
    const { api, host } = await setup(
      {
        prompt: async (
          _text,
          _settings,
          _context,
          _history,
          _execute,
          _update,
          desktop,
        ) => {
          const image = await desktop!.observe({});
          await desktop!.action("call-1", {
            observationId: image.observationId,
            action: "click",
            x: 0,
            y: 0,
          });
          actionCompleted = true;
        },
      },
      10000,
      fixture.transport,
    );
    expect(
      (
        await api("chat", {
          requestId: "desktop-chat-001",
          text: "Click the test control.",
        })
      ).status,
    ).toBe(202);
    await expect.poll(() => host.snapshot().desktop.status).toBe("unknown");
    expect(
      (
        await api("execute", {
          requestId: "blocked-by-desktop",
          mode: "query",
          code: "return 1;",
        })
      ).status,
    ).toBe(409);
    // The unknown status is visible before the action finishes persisting its
    // receipt and releases the desktop lock. Wait before requesting a capture.
    await expect.poll(() => actionCompleted).toBe(true);
    expect((await api("desktop/observe", {})).status).toBe(200);
    expect(host.snapshot().desktop.status).toBe("unknown");
  });

  it("handles Stop outside the mutation queue during a pending desktop capture", async () => {
    const fixture = desktopFixture();
    const request = fixture.transport.request;
    let release!: () => void;
    let started = false;
    fixture.transport.request = async (kind, input, id) => {
      if (kind === "observe") {
        started = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return request(kind, input, id);
    };
    const { api } = await setup({}, 10000, fixture.transport);
    const capture = api("desktop/observe", {});
    await expect.poll(() => started).toBe(true);
    expect((await api("desktop/stop", {})).status).toBe(200);
    expect(fixture.stops()).toBeGreaterThan(0);
    release();
    expect((await capture).status).toBe(200);
  });

  it("journals and deduplicates the entire batch and fences an unknown group", async () => {
    const { api, dealer, native, dir, host } = await setup();
    const input = {
      requestId: "batch-request-001",
      mode: "batch",
      documentToken: "doc-1",
      steps: [
        { name: "First", code: "return 1;" },
        { name: "Second", code: "return 2;" },
      ],
      verify: { code: "return true;" },
    };
    expect(
      (await api("execute", { ...input, documentToken: undefined })).status,
    ).toBe(400);
    expect(
      (await api("execute", { ...input, documentToken: "closed" })).status,
    ).toBe(409);
    const accepted = await (await api("execute", input)).json();
    const [frame] = await dealer.receive();
    expect(JSON.parse(frame.toString()).command).toMatchObject({
      mode: "batch",
      steps: input.steps,
      verify: input.verify,
      documentToken: "doc-1",
    });
    expect(
      JSON.parse(await readFile(join(dir, "journal.json"), "utf8"))
        .operations[0].steps,
    ).toEqual(input.steps);
    expect(await (await api("execute", input)).json()).toEqual(accepted);
    expect(
      (await api("execute", { ...input, verify: { code: "return false;" } }))
        .status,
    ).toBe(409);
    await native("operation", {
      operationId: accepted.operationId,
      status: "unknown",
      transactionStatus: "Unknown",
    });
    await expect
      .poll(() => host.snapshot().operations[0].status)
      .toBe("unknown");
    expect(
      (await api("execute", { ...input, requestId: "batch-request-002" }))
        .status,
    ).toBe(409);
  });

  it("targets a non-active document and preserves the explicit binding in the journal", async () => {
    const { api, native, dealer, host, dir } = await setup();
    const target = {
      ...context.document,
      token: "project-2",
      title: "Other project",
    };
    await native("context", {
      ...context,
      documents: [context.document, target],
    });
    await expect.poll(() => host.snapshot().context?.documents?.length).toBe(2);
    expect(
      (
        await api("execute", {
          requestId: "other-doc-001",
          code: "return ctx.Doc.Title;",
          mode: "modify",
          documentToken: target.token,
        })
      ).status,
    ).toBe(202);
    const [frame] = await dealer.receive();
    expect(JSON.parse(frame.toString()).command).toMatchObject({
      documentToken: target.token,
      mode: "modify",
    });
    expect(
      JSON.parse(await readFile(join(dir, "journal.json"), "utf8"))
        .operations[0].documentToken,
    ).toBe(target.token);
  });

  it("rejects stale, invalid and read-only targets without falling back to the active document", async () => {
    const { api, native, host } = await setup();
    await native("context", {
      ...context,
      documents: [
        context.document,
        { ...context.document, token: "readonly", isReadOnly: true },
      ],
    });
    await expect.poll(() => host.snapshot().context?.documents?.length).toBe(2);
    const input = {
      requestId: "invalid-doc-01",
      code: "return 1;",
      mode: "modify",
    };
    expect(
      (await api("execute", { ...input, documentToken: "closed" })).status,
    ).toBe(409);
    expect(
      (await api("execute", { ...input, documentToken: "readonly" })).status,
    ).toBe(409);
    expect((await api("execute", { ...input, documentToken: 42 })).status).toBe(
      400,
    );
    expect(
      (await api("execute", { ...input, documentToken: null })).status,
    ).toBe(409);
    expect(host.snapshot().operations).toHaveLength(0);
  });

  it.each(["query", "api"])(
    "allows %s with no active document",
    async (mode) => {
      const { api, native, dealer, host } = await setup();
      await native("context", { ...context, document: null, documents: [] });
      await expect.poll(() => host.snapshot().context?.document).toBeNull();
      expect(
        (
          await api("execute", {
            requestId: "no-doc-00001",
            code: "return ctx.Documents.Length;",
            mode,
          })
        ).status,
      ).toBe(202);
      const [frame] = await dealer.receive();
      expect(JSON.parse(frame.toString()).command).toMatchObject({
        documentToken: null,
        mode,
      });
    },
  );

  it("rejects browser/native credential confusion and hostile browser origins", async () => {
    const { host, api, native } = await setup();
    expect((await api("state", undefined, "native-secret")).status).toBe(401);
    const cross = await fetch(host.url + "/api/state", {
      headers: {
        Authorization: `Bearer ${host.browserToken}`,
        Origin: "https://attacker.example",
      },
    });
    expect(cross.status).toBe(403);
    await native("context", { ...context, document: null }, host.browserToken);
    expect((await (await api("state")).json()).context.document.token).toBe(
      "doc-1",
    );
  });

  it("journals before dispatch, returns native results, and deduplicates UI submissions", async () => {
    const { api, dealer, native, dir } = await setup();
    const input = {
      requestId: "request-0001",
      code: "return 42;",
      mode: "query",
    };
    const response = await api("execute", input);
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const [frame] = await dealer.receive();
    const command = JSON.parse(frame.toString()).command;
    expect(command).toMatchObject({
      kind: "execute",
      documentToken: "doc-1",
      code: "return 42;",
      operationId: accepted.operationId,
    });
    const saved = JSON.parse(await readFile(join(dir, "journal.json"), "utf8"));
    expect(saved.requests[input.requestId].response.operationId).toBe(
      command.operationId,
    );
    expect(await (await api("execute", input)).json()).toEqual(accepted);
    expect(
      (await api("execute", { ...input, code: "return 43;" })).status,
    ).toBe(409);
    await native("operation", {
      operationId: command.operationId,
      status: "succeeded",
      result: 42,
    });
    await expect
      .poll(
        async () => (await (await api("state")).json()).operations[0].status,
      )
      .toBe("succeeded");
    expect((await (await api("state")).json()).operations[0].result).toBe(42);
  });

  it("fences uncertain mutations after disconnect until a native receipt reconciles them", async () => {
    const { api, dealer, native } = await setup();
    await api("execute", {
      requestId: "mutation-0001",
      code: "return 1;",
      mode: "modify",
    });
    const [frame] = await dealer.receive();
    const { command } = JSON.parse(frame.toString());
    await native("disconnect");
    await expect
      .poll(
        async () => (await (await api("state")).json()).operations[0].status,
      )
      .toBe("unknown");
    await native("context", context);
    expect(
      (
        await api("execute", {
          requestId: "mutation-0002",
          code: "return 2;",
          mode: "modify",
        })
      ).status,
    ).toBe(409);
    await native("operation", {
      operationId: command.operationId,
      status: "succeeded",
      result: 1,
      transactionStatus: "Committed",
    });
    await expect
      .poll(async () => (await (await api("state")).json()).busy)
      .toBe(false);
    expect(
      (
        await api("execute", {
          requestId: "mutation-0002",
          code: "return 2;",
          mode: "modify",
        })
      ).status,
    ).toBe(202);
  });

  it.each(["query", "batch"] as const)(
    "routes an agent %s tool through the same native executor and persists the answer",
    async (mode) => {
      let prompts = 0;
      const { api, dealer, native } = await setup({
        prompt: async (
          _text,
          _settings,
          _context,
          _history,
          execute,
          update,
        ) => {
          prompts++;
          const result = await execute(
            mode === "batch"
              ? {
                  mode,
                  documentToken: "doc-1",
                  steps: [{ name: "Edit", code: "return 3;" }],
                }
              : { code: "return 3;", mode },
          );
          update(`Found ${result.result} levels.`);
        },
      });
      const request = { requestId: "chat-000001", text: "How many levels?" };
      expect((await api("chat", request)).status).toBe(202);
      const [frame] = await dealer.receive();
      const { command } = JSON.parse(frame.toString());
      expect(command.mode).toBe(mode);
      await native("operation", {
        operationId: command.operationId,
        status: "succeeded",
        result: 3,
      });
      await expect
        .poll(
          async () => (await (await api("state")).json()).messages.at(-1).text,
        )
        .toBe("Found 3 levels.");
      expect((await api("chat", request)).status).toBe(202);
      expect(prompts).toBe(1);
    },
  );

  it("sends cancellation without claiming a running operation is stopped", async () => {
    const { api, dealer } = await setup();
    await api("execute", {
      requestId: "cancel-00001",
      code: "return 1;",
      mode: "modify",
    });
    const [frame] = await dealer.receive();
    const { command } = JSON.parse(frame.toString());
    await api("cancel", {});
    const [cancelFrame] = await dealer.receive();
    expect(JSON.parse(cancelFrame.toString()).command).toEqual({
      kind: "cancel",
      operationId: command.operationId,
    });
    expect((await (await api("state")).json()).busy).toBe(true);
  });

  it("marks interrupted journal records unknown on restart and never replays them", async () => {
    const { host, api, dealer, dir } = await setup();
    const input = {
      requestId: "restart-0001",
      code: "return 1;",
      mode: "modify",
    };
    const accepted = await (await api("execute", input)).json();
    await dealer.receive();
    await host.close();
    // Avoid closing the original host a second time during cleanup.
    resources.splice(resources.length - 2, 1);
    const restarted = await createHost({
      instanceId: "test-instance",
      nativeToken: "new-native-secret",
      dataDir: dir,
      webDir: dir,
      agent: {
        providers: [],
        configured: () => false,
        setKey: async () => {},
        prompt: async () => {},
        abort: async () => {},
      },
    });
    resources.push(() => restarted.close());
    expect(restarted.snapshot().operations[0]).toMatchObject({
      operationId: accepted.operationId,
      status: "unknown",
    });
    const response = await fetch(restarted.url + "/api/execute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${restarted.browserToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(accepted);
    expect(restarted.snapshot().busy).toBe(true);
  });

  it("bridges OAuth URL, prompt response and completion without persisting codes", async () => {
    let signedIn = false;
    const { api, dir } = await setup({
      providers: [
        {
          id: "fixture-oauth",
          name: "Subscription",
          models: [],
          authMethods: [{ type: "oauth", label: "Sign in" }],
          canLogout: true,
        },
      ],
      login: async (_provider, type, interaction) => {
        expect(type).toBe("oauth");
        interaction.notify({
          type: "auth_url",
          url: "https://example.test/oauth",
          instructions: "Sign in in your browser.",
        });
        const code = await interaction.prompt({
          type: "manual_code",
          message: "Paste code",
        });
        expect(code).toBe("test-oauth-code");
        signedIn = true;
      },
      logout: async () => {
        signedIn = false;
      },
    });
    expect(
      (
        await api("auth/login", {
          provider: "fixture-oauth",
          authType: "oauth",
        })
      ).status,
    ).toBe(202);
    let state: any;
    await expect
      .poll(async () => {
        state = await (await api("state")).json();
        return state.auth.request?.prompt;
      })
      .toBe("Paste code");
    expect(state.auth.url).toBe("https://example.test/oauth");
    expect(
      (await api("auth/respond", { requestId: "stale", value: "bad" })).status,
    ).toBe(400);
    expect(
      (
        await api("auth/respond", {
          requestId: state.auth.request.requestId,
          value: "test-oauth-code",
        })
      ).status,
    ).toBe(200);
    await expect
      .poll(async () => (await (await api("state")).json()).auth.completedCount)
      .toBe(1);
    expect(signedIn).toBe(true);
    expect(await readFile(join(dir, "journal.json"), "utf8")).not.toContain(
      "test-oauth-code",
    );
    expect(
      (await api("auth/logout", { provider: "fixture-oauth" })).status,
    ).toBe(200);
    expect(signedIn).toBe(false);
  });

  it("cancels a pending provider prompt through the SDK signal", async () => {
    const { api } = await setup({
      providers: [
        {
          id: "fixture",
          models: [],
          authMethods: [{ type: "api_key", label: "API key" }],
        },
      ],
      login: async (_provider, _type, interaction) => {
        await interaction.prompt({ type: "secret", message: "API key" });
      },
    });
    await api("auth/login", { provider: "fixture", authType: "api_key" });
    await expect
      .poll(
        async () => (await (await api("state")).json()).auth.request?.password,
      )
      .toBe(true);
    await api("auth/cancel", {});
    await expect
      .poll(async () => (await (await api("state")).json()).auth.busy)
      .toBe(false);
    expect((await (await api("state")).json()).auth.error).toContain(
      "cancelled",
    );
  });
});
