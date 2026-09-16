import { validateExecuteInput } from "./execute-input.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { resolve, extname, sep, relative, isAbsolute } from "node:path";
import type {
  Agent,
  AuthState,
  Context,
  ExecuteInput,
  Message,
  Operation,
  Settings,
} from "./types.js";
import { Router } from "zeromq";
import { DesktopController, type DesktopTiming } from "./desktop-controller.js";
import type { DesktopTransport } from "./desktop-types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { Type } from "typebox";
import { HostSkillLibrary } from "./skills.js";
import { RunHistory, bounded } from "./history.js";
import { HISTORY_LIMITS, type RunDetail } from "./history-types.js";

const terminal = new Set(["succeeded", "failed", "cancelled"]);
const statuses = new Set([
  "compiling",
  "queued",
  "running",
  ...terminal,
  "unknown",
]);
function matchesSecret(value: unknown, secret: string): boolean {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
interface Persisted {
  version?: number;
  messages: Message[];
  operations: Operation[];
  requests: Record<string, { fingerprint: string; response: object }>;
  settings: Settings;
}
export interface HostOptions {
  instanceId: string;
  nativeToken: string;
  dataDir: string;
  webDir: string;
  agent: Agent;
  heartbeatMs?: number;
  userDir?: string;
  desktop?: DesktopTransport;
  desktopTiming?: DesktopTiming;
}

export async function createHost(options: HostOptions) {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const journal = resolve(options.dataDir, "journal.json");
  let state: Persisted = {
    messages: [],
    operations: [],
    requests: {},
    settings: {
      provider: "anthropic",
      model:
        options.agent.providers.find((p) => p.id === "anthropic")?.models[0]
          ?.id ?? "",
      configured: false,
    },
  };
  try {
    state = JSON.parse(await readFile(journal, "utf8")) as Persisted;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // Migration is lossless and separate from retention. Old payloads are immutable;
  // only unresolved receipts continue participating in live journal rewrites.
  const legacyFile = resolve(options.dataDir, "legacy-history.json");
  let legacy: { messages: Message[]; operations: Operation[] } = {
    messages: [],
    operations: [],
  };
  try {
    legacy = JSON.parse(await readFile(legacyFile, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!state.version && (state.messages.length || state.operations.length)) {
    legacy = { messages: state.messages, operations: state.operations };
    await writeFile(`${legacyFile}.tmp`, JSON.stringify(legacy), {
      mode: 0o600,
    });
    await rename(`${legacyFile}.tmp`, legacyFile);
  }
  const archivedMessages = new Set(legacy.messages.map((m) => m.id));
  const archivedOperations = new Set(
    legacy.operations
      .filter((o) => terminal.has(o.status))
      .map((o) => o.operationId),
  );
  state.messages = [
    ...new Map(
      [...legacy.messages, ...state.messages].map((m) => [m.id, m]),
    ).values(),
  ];
  state.operations = [
    ...new Map(
      [...legacy.operations, ...state.operations].map((o) => [
        o.operationId,
        o,
      ]),
    ).values(),
  ];
  const runs = await RunHistory.open(resolve(options.dataDir, "runs"));
  for (const summary of [...runs.summaries.values()].sort(
    (a, b) => a.number - b.number,
  )) {
    if (!summary.detailsAvailable) continue;
    const detail = await runs.detail(summary.id);
    for (const message of detail.messages) {
      if (!state.messages.some((m) => m.id === message.id))
        state.messages.push(message);
      if (summary.status !== "running") archivedMessages.add(message.id);
    }
    for (const operation of detail.operations) {
      if (
        !state.operations.some((o) => o.operationId === operation.operationId)
      )
        state.operations.push(operation);
      if (terminal.has(operation.status))
        archivedOperations.add(operation.operationId);
    }
  }
  const manualDirectory = resolve(options.dataDir, "manual-history");
  await mkdir(manualDirectory, { recursive: true, mode: 0o700 });
  for (const name of await readdir(manualDirectory))
    if (name.endsWith(".json")) {
      const op = JSON.parse(
        await readFile(resolve(manualDirectory, name), "utf8"),
      ) as Operation;
      if (!state.operations.some((o) => o.operationId === op.operationId))
        state.operations.push(op);
      archivedOperations.add(op.operationId);
    }
  state.operations.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  state.messages.sort((a, b) => {
    const left = a.runId ? (runs.summaries.get(a.runId)?.number ?? 0) : 0;
    const right = b.runId ? (runs.summaries.get(b.runId)?.number ?? 0) : 0;
    return (
      left - right ||
      (left
        ? Number(a.role === "assistant") - Number(b.role === "assistant")
        : 0)
    );
  });
  const skills = new HostSkillLibrary(
    resolve(options.webDir, "../.."),
    resolve(options.userDir ?? options.dataDir, "skills-preferences.json"),
    resolve(options.userDir ?? options.dataDir, "skills"),
  );
  await skills.initialize();
  const draftFile = resolve(options.dataDir, "console-draft.json");
  let consoleDraft: unknown = null;
  try {
    consoleDraft = JSON.parse(await readFile(draftFile, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  state.version = 2;
  let activeRun: RunDetail | undefined;
  let storageError: string | undefined;
  let closing = false;
  const toolScope = new AsyncLocalStorage<string>();
  const settingsFile = resolve(
    options.userDir ?? options.dataDir,
    "settings.json",
  );
  await mkdir(resolve(options.userDir ?? options.dataDir), {
    recursive: true,
    mode: 0o700,
  });
  try {
    state.settings = JSON.parse(await readFile(settingsFile, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const op of state.operations)
    if (!terminal.has(op.status)) {
      op.status = "unknown";
      op.error =
        "Host restarted before a confirmed native outcome. Do not replay this operation.";
    }
  let context: Context | null = null,
    lastHeartbeat = 0,
    chatBusy = false;
  let turnAbort: AbortController | undefined;
  let cancellationEpoch = 0;
  let auth: AuthState = { busy: false, completedCount: 0 };
  let authController: AbortController | undefined;
  let authResponse:
    | {
        id: string;
        resolve: (value: string) => void;
      }
    | undefined;
  const router = new Router({ linger: 0, maxMessageSize: 1024 * 1024 });
  await router.bind("tcp://127.0.0.1:*");
  const nativeEndpoint = router.lastEndpoint!;
  let nativeRoute: Buffer | undefined;
  const queue: object[] = [],
    events = new Set<ServerResponse>();
  const waiters = new Map<
    string,
    { resolve: (op: Operation) => void; reject: (e: Error) => void }
  >();
  const browserToken = randomBytes(32).toString("hex");
  let url = "";
  let saveChain = Promise.resolve();
  const persist = () => {
    const data = JSON.stringify({
      ...state,
      messages: state.messages.filter((m) => !archivedMessages.has(m.id)),
      operations: state.operations.filter(
        (o) => !archivedOperations.has(o.operationId),
      ),
    });
    saveChain = saveChain.then(async () => {
      await writeFile(`${journal}.tmp`, data, { mode: 0o600 });
      await rename(`${journal}.tmp`, journal);
    });
    return saveChain;
  };
  await persist();
  const connected = () =>
    lastHeartbeat > 0 &&
    Date.now() - lastHeartbeat < (options.heartbeatMs ?? 10000);
  const busy = () =>
    !!storageError ||
    chatBusy ||
    desktop.inFlight ||
    desktop.fenced ||
    state.operations.some((o) => !terminal.has(o.status));
  const snapshot = () => ({
    instanceId: options.instanceId,
    context,
    connected: connected(),
    busy: busy(),
    chatBusy,
    storageError,
    auth,
    ...state,
    requests: undefined,
    runs: runs.list({ limit: 50 }).runs,
    desktop: desktop.snapshot(),
    operations: state.operations.slice(-100),
    messages: state.messages.slice(-200),
    settings: {
      ...state.settings,
      configured: options.agent.configured(state.settings.provider),
    },
    providers: options.agent.providers,
  });
  let broadcastTimer: NodeJS.Timeout | undefined;
  const broadcast = () => {
    if (broadcastTimer || events.size === 0) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of events) {
        if (res.writableLength > 1024 * 1024) {
          res.end();
          events.delete(res);
        } else res.write(data);
      }
    }, 50);
  };
  const desktop = new DesktopController(
    options.desktop,
    options.dataDir,
    (token) => {
      if (!connected()) throw new Error("Revit is disconnected.");
      if (state.operations.some((op) => !terminal.has(op.status)))
        throw new Error(
          "An API operation is pending or unknown. Desktop input is blocked; use the read-only screenshot control.",
        );
      if ((context?.document?.token ?? null) !== token)
        throw new Error(
          "Active document changed during this desktop workflow. Start a new turn.",
        );
    },
    broadcast,
    (reason) => {
      turnAbort?.abort(new Error(reason ?? "Desktop control stopped."));
      void options.agent.abort().catch(() => {});
    },
    () => ({
      documentToken: context?.document?.token ?? null,
      documentTitle: context?.document?.title,
      capturedAt: context?.capturedAt,
      ageMs:
        context?.capturedAt && Number.isFinite(Date.parse(context.capturedAt))
          ? Math.max(0, Date.now() - Date.parse(context.capturedAt))
          : undefined,
      source: "cached-native-context",
    }),
    options.desktopTiming,
  );
  await desktop.init();
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  let sendChain = Promise.resolve();
  const dispatch = (command: object) => {
    if (!nativeRoute) {
      queue.push(command);
      return;
    }
    const route = nativeRoute;
    sendChain = sendChain
      .then(() =>
        router.send([route, JSON.stringify({ type: "command", command })]),
      )
      .catch(() => {
        const work = mutationChain.then(markDisconnected);
        mutationChain = work.catch(() => {});
      });
  };
  const markDisconnected = async () => {
    if (activeRun?.run.mode !== "authoring") turnAbort?.abort();
    void desktop.stop().catch(() => {});
    lastHeartbeat = 0;
    nativeRoute = undefined;
    for (const op of state.operations)
      if (!terminal.has(op.status) && op.status !== "unknown") {
        op.status = "unknown";
        op.error =
          "Native connection lost; execution outcome is unknown. Do not retry.";
        waiters.get(op.operationId)?.resolve(op);
        waiters.delete(op.operationId);
      }
    queue.length = 0;
    await persist();
    broadcast();
  };
  const validate = (input: any): ExecuteInput => {
    try {
      return validateExecuteInput(input);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  };
  const checkDocument = () => {
    if (!connected()) throw new HttpError(409, "Revit is disconnected.");
    if (desktop.inFlight || desktop.fenced)
      throw new HttpError(
        409,
        "Desktop input is pending or its outcome is unknown.",
      );
    if (state.operations.some((o) => !terminal.has(o.status)))
      throw new HttpError(
        409,
        "An operation is pending or its outcome is unknown.",
      );
    return context?.document;
  };
  const createOperation = async (input: ExecuteInput) => {
    const validated = validate(input);
    const activeDocument = checkDocument();
    const token =
      validated.documentToken === undefined
        ? (activeDocument?.token ?? null)
        : validated.documentToken;
    const doc =
      token === null
        ? null
        : (context?.documents ?? (activeDocument ? [activeDocument] : [])).find(
            (d) => d.token === token,
          );
    if (token !== null && !doc)
      throw new HttpError(
        409,
        "The target document is no longer open. Refresh the document list.",
      );
    if ((validated.mode === "modify" || validated.mode === "batch") && !doc)
      throw new HttpError(409, "Modify requires an open target document.");
    if (
      (validated.mode === "modify" || validated.mode === "batch") &&
      doc?.isReadOnly
    )
      throw new HttpError(409, "Document is read-only.");
    const op: Operation = {
      ...validated,
      operationId: randomUUID(),
      documentToken: token,
      createdAt: new Date().toISOString(),
      status: "queued",
      runId: activeRun?.run.id,
      toolCallId: toolScope.getStore(),
      documentTitle: doc?.title,
      documentKind: doc ? (doc.isFamily ? "family" : "project") : undefined,
      contextCapturedAt: context?.capturedAt,
      historicalDocumentReference: true,
      executionMode: activeRun ? "execution" : "manual",
    };
    state.operations.push(op);
    if (activeRun) {
      activeRun.operations.push(op);
      const call = activeRun.calls.find((c) => c.id === op.toolCallId);
      call?.operationIds.push(op.operationId);
      await runs.save(activeRun);
    }
    await persist();
    return op;
  };
  const execute = async (
    input: ExecuteInput,
    signal?: AbortSignal,
  ): Promise<Operation> => {
    if (signal?.aborted) throw new Error("Cancelled");
    desktop.invalidateObservation();
    const op = await createOperation(input);
    if (signal?.aborted) {
      op.status = "cancelled";
      op.error = "Cancelled before native dispatch.";
      await persist();
      broadcast();
      return op;
    }
    const waiting = new Promise<Operation>((resolve, reject) =>
      waiters.set(op.operationId, { resolve, reject }),
    );
    const cancel = () =>
      dispatch({ kind: "cancel", operationId: op.operationId });
    signal?.addEventListener("abort", cancel, { once: true });
    dispatch({ kind: "execute", ...op });
    broadcast();
    if (signal?.aborted) cancel();
    try {
      return await waiting;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
  const body = async (req: IncomingMessage): Promise<any> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new HttpError(413, "Request too large.");
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
      return value;
    } catch {
      throw new HttpError(400, "Expected JSON object.");
    }
  };
  const dedup = (data: any) => {
    if (
      typeof data.requestId !== "string" ||
      !/^[a-zA-Z0-9-]{8,80}$/.test(data.requestId)
    )
      throw new HttpError(400, "A stable requestId is required.");
    const fingerprint = JSON.stringify(data);
    const old = Object.hasOwn(state.requests, data.requestId)
      ? state.requests[data.requestId]
      : undefined;
    if (old && old.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        "requestId was already used for different content.",
      );
    return { old, fingerprint };
  };
  // Serialize state-changing requests across asynchronous disk writes.
  let mutationChain = Promise.resolve();
  async function mutate(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    submissionEpoch: number,
  ) {
    const data = await body(req);
    if (path === "/api/console-draft") {
      if (
        data.version !== 1 ||
        typeof data.code !== "string" ||
        !["query", "modify", "api", "batch"].includes(data.mode) ||
        !Array.isArray(data.steps) ||
        data.steps.length > 20 ||
        data.steps.some(
          (s: any) =>
            !s || typeof s.name !== "string" || typeof s.code !== "string",
        ) ||
        typeof data.verify !== "string" ||
        typeof data.documentToken !== "string" ||
        (data.sessionId !== null && typeof data.sessionId !== "string") ||
        Buffer.byteLength(JSON.stringify(data)) > HISTORY_LIMITS.draftBytes
      )
        throw new HttpError(
          400,
          "Invalid console draft or draft exceeds 512 KiB.",
        );
      const temp = `${draftFile}.tmp`;
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      await rename(temp, draftFile);
      consoleDraft = data;
      send(res, 200, { draft: consoleDraft });
      return;
    }
    if (
      path === "/api/skills/settings" ||
      /^\/api\/skills\/[^/]+\/restore$/.test(path)
    ) {
      if (
        path.endsWith("/restore") &&
        decodeURIComponent(path.split("/")[3]!) !== data.id
      )
        throw new HttpError(
          400,
          "Restore target does not match the skill URL.",
        );
      try {
        const result = path.endsWith("/restore")
          ? await skills.restore(data)
          : await skills.update(data);
        send(res, 200, { ...result, appliesNextRun: chatBusy });
        broadcast();
      } catch (error) {
        throw new HttpError(409, (error as Error).message);
      }
      return;
    }
    if (path === "/api/auth/respond") {
      if (
        !authResponse ||
        data.requestId !== authResponse.id ||
        typeof data.value !== "string" ||
        data.value.length > 16384
      )
        throw new HttpError(400, "This sign-in prompt is no longer active.");
      if (
        auth.request?.type === "select" &&
        !auth.request.options?.some((option) => option.id === data.value)
      )
        throw new HttpError(400, "Choose an available option.");
      const response = authResponse;
      authResponse = undefined;
      auth.request = undefined;
      response.resolve(data.value);
      send(res, 200, { ok: true });
      broadcast();
      return;
    }
    if (path === "/api/auth/cancel") {
      authController?.abort();
      send(res, 200, { ok: true });
      return;
    }
    if (path.startsWith("/api/auth/")) {
      if (busy() || auth.busy)
        throw new HttpError(
          409,
          "Wait for the current operation or sign-in to finish.",
        );
      if (path === "/api/auth/refresh") {
        await options.agent.refresh?.();
        send(res, 200, { ok: true });
        broadcast();
        return;
      }
      if (path === "/api/auth/provider") {
        if (
          !options.agent.addProvider ||
          typeof data.id !== "string" ||
          !/^[a-z0-9][a-z0-9-]{1,63}$/.test(data.id) ||
          typeof data.baseUrl !== "string" ||
          !Array.isArray(data.models) ||
          !data.models.length ||
          data.models.length > 50 ||
          data.models.some(
            (m: any) =>
              !m ||
              typeof m.id !== "string" ||
              !m.id.trim() ||
              m.id.length > 200 ||
              (m.name !== undefined &&
                (typeof m.name !== "string" || m.name.length > 200)) ||
              (m.supportsImages !== undefined &&
                typeof m.supportsImages !== "boolean"),
          )
        )
          throw new HttpError(
            400,
            "A provider ID, base URL, and model IDs are required.",
          );
        let endpoint: URL;
        try {
          endpoint = new URL(data.baseUrl);
        } catch {
          throw new HttpError(400, "Invalid API base URL.");
        }
        if (
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash
        )
          throw new HttpError(
            400,
            "Use an HTTP(S) API base URL without embedded credentials, query, or fragment.",
          );
        if (
          data.apiKey !== undefined &&
          (typeof data.apiKey !== "string" || data.apiKey.length > 8192)
        )
          throw new HttpError(400, "Invalid API key.");
        if (
          data.name !== undefined &&
          (typeof data.name !== "string" || data.name.length > 200)
        )
          throw new HttpError(400, "Invalid provider name.");
        if (options.agent.providers.some((p) => p.id === data.id))
          throw new HttpError(409, "That provider ID already exists.");
        await options.agent.addProvider({
          id: data.id,
          name: data.name,
          baseUrl: endpoint.toString().replace(/\/$/, ""),
          apiKey: data.apiKey,
          models: data.models,
        });
        send(res, 200, { ok: true });
        broadcast();
        return;
      }
      const provider = options.agent.providers.find(
        (p) => p.id === data.provider,
      );
      if (!provider) throw new HttpError(400, "Unknown provider.");
      if (path === "/api/auth/logout") {
        if (!provider.canLogout || !options.agent.logout)
          throw new HttpError(
            400,
            "This credential is managed outside Revcode.",
          );
        await options.agent.logout(provider.id);
        send(res, 200, { ok: true });
        broadcast();
        return;
      }
      if (
        path !== "/api/auth/login" ||
        !options.agent.login ||
        !provider.authMethods?.some((m) => m.type === data.authType)
      )
        throw new HttpError(400, "Unsupported sign-in method.");
      if (
        data.apiKey !== undefined &&
        (typeof data.apiKey !== "string" || data.apiKey.length > 8192)
      )
        throw new HttpError(400, "Invalid API key.");
      const controller = new AbortController();
      authController = controller;
      auth = {
        provider: provider.id,
        busy: true,
        completedCount: auth.completedCount,
        notice: "Starting sign-in…",
      };
      const timeout = setTimeout(() => controller.abort(), 300000);
      let suppliedKey = data.apiKey?.trim();
      void options.agent
        .login(provider.id, data.authType, {
          signal: controller.signal,
          notify: (event) => {
            if (event.type === "auth_url") {
              auth.url = event.url;
              auth.notice = event.instructions;
            } else if (event.type === "device_code") {
              auth.url = event.verificationUri;
              auth.userCode = event.userCode;
            } else {
              auth.notice = event.message;
              if (event.type === "info" && event.links?.[0])
                auth.url = event.links[0].url;
            }
            broadcast();
          },
          prompt: async (prompt) => {
            if (prompt.type === "secret" && suppliedKey) {
              const value = suppliedKey;
              suppliedKey = undefined;
              return value;
            }
            const signal = prompt.signal
              ? AbortSignal.any([controller.signal, prompt.signal])
              : controller.signal;
            if (signal.aborted) throw new Error("Sign-in cancelled.");
            const id = randomUUID();
            auth.request = {
              requestId: id,
              prompt: prompt.message,
              type: prompt.type,
              password: prompt.type === "secret",
              ...("placeholder" in prompt
                ? { placeholder: prompt.placeholder }
                : {}),
              ...("options" in prompt ? { options: prompt.options } : {}),
            };
            broadcast();
            return new Promise<string>((resolve, reject) => {
              const cancel = () => {
                if (authResponse?.id === id) {
                  authResponse = undefined;
                  auth.request = undefined;
                }
                reject(new Error("Sign-in cancelled."));
                broadcast();
              };
              signal.addEventListener("abort", cancel, { once: true });
              authResponse = {
                id,
                resolve: (value) => {
                  signal.removeEventListener("abort", cancel);
                  resolve(value);
                },
              };
              if (signal.aborted) cancel();
            });
          },
        })
        .then(() => {
          auth.completedCount++;
          auth.notice = "Connected.";
        })
        .catch(() => {
          auth.error = controller.signal.aborted
            ? "Sign-in cancelled or timed out."
            : "Sign-in failed. Retry provider setup and check the account or API key.";
        })
        .finally(() => {
          clearTimeout(timeout);
          authController = undefined;
          authResponse = undefined;
          auth.busy = false;
          auth.request = undefined;
          auth.url = undefined;
          auth.userCode = undefined;
          broadcast();
        });
      send(res, 202, { ok: true });
      broadcast();
      return;
    }
    if (path === "/api/settings") {
      if (busy() || auth.busy)
        throw new HttpError(
          409,
          "Wait for the current operation or sign-in to finish.",
        );
      if (
        !options.agent.providers.some(
          (p) =>
            p.id === data.provider && p.models.some((m) => m.id === data.model),
        )
      )
        throw new HttpError(400, "Unknown provider/model.");
      if (
        data.apiKey !== undefined &&
        (typeof data.apiKey !== "string" || data.apiKey.length > 8192)
      )
        throw new HttpError(400, "Invalid API key.");
      if (data.apiKey?.trim())
        await options.agent.setKey(data.provider, data.apiKey.trim());
      state.settings = {
        provider: data.provider,
        model: data.model,
        configured: options.agent.configured(data.provider),
      };
      const tempSettings = `${settingsFile}.${randomUUID()}.tmp`;
      await writeFile(tempSettings, JSON.stringify(state.settings), {
        mode: 0o600,
      });
      await rename(tempSettings, settingsFile);
      await persist();
      send(res, 200, state.settings);
      broadcast();
      return;
    }
    if (path === "/api/execute" || path === "/api/chat") {
      if (submissionEpoch !== cancellationEpoch)
        throw new HttpError(409, "Request cancelled before acceptance.");
      const { old, fingerprint } = dedup(data);
      if (old) {
        send(res, 202, old.response);
        return;
      }
      const authoring =
        path === "/api/chat" &&
        (data.mode === "authoring" ||
          /\b(?:create|make|update|revise|edit)\s+(?:(?:a|an|the|this|that|existing|reusable)\s+){0,3}skill\b/i.test(
            String(data.text ?? ""),
          ));
      if (storageError) throw new HttpError(409, storageError);
      if ((authoring ? chatBusy : busy()) || auth.busy)
        throw new HttpError(
          409,
          "Revcode is busy or awaiting an uncertain outcome.",
        );
      if (!authoring) checkDocument();
      if (path === "/api/execute") {
        const op = await createOperation(validate(data));
        const response = { operationId: op.operationId };
        state.requests[data.requestId] = { fingerprint, response };
        await persist();
        if (submissionEpoch !== cancellationEpoch) {
          op.status = "cancelled";
          op.error = "Cancelled before native dispatch.";
          await persist();
          send(res, 202, response);
          broadcast();
          return;
        }
        dispatch({ kind: "execute", ...op });
        send(res, 202, response);
        broadcast();
        return;
      }
      if (
        typeof data.text !== "string" ||
        !data.text.trim() ||
        data.text.length > 32000
      )
        throw new HttpError(400, "Message must contain 1–32000 characters.");
      if (!options.agent.configured(state.settings.provider))
        throw new HttpError(409, "Connect a provider first.");
      if (
        data.mode !== undefined &&
        !["execution", "authoring"].includes(data.mode)
      )
        throw new HttpError(400, "Invalid composer mode.");
      if (
        data.selectedSkillIds !== undefined &&
        (!Array.isArray(data.selectedSkillIds) ||
          data.selectedSkillIds.some((id: unknown) => typeof id !== "string"))
      )
        throw new HttpError(400, "Invalid selected skills.");
      let skillSnapshot;
      try {
        skillSnapshot = await skills.createRunSnapshot(
          data.selectedSkillIds ?? [],
        );
      } catch (error) {
        throw new HttpError(409, (error as Error).message);
      }
      let sourceRunIds: string[] = data.sourceRunIds ?? [];
      if (
        !Array.isArray(sourceRunIds) ||
        sourceRunIds.length > 20 ||
        sourceRunIds.some((id) => typeof id !== "string")
      )
        throw new HttpError(400, "Select up to 20 source runs.");
      if (authoring && !sourceRunIds.length) {
        const explicitNumbers = [
          ...data.text.matchAll(/\brun\s*#?\s*(\d+)\b/gi),
        ].map((m: RegExpMatchArray) => Number(m[1]));
        if (explicitNumbers.length)
          sourceRunIds = explicitNumbers.map((number: number) => {
            const run = [...runs.summaries.values()].find(
              (r) => r.number === number,
            );
            if (!run)
              throw new HttpError(
                409,
                `Run ${number} is unavailable in this host history.`,
              );
            return run.id;
          });
        else if (
          /\b(?:this|recent|last|previous)\s+(?:run|work)|from\s+(?:a\s+)?run/i.test(
            data.text,
          )
        ) {
          const latest = [...runs.summaries.values()]
            .filter((r) => r.intent === "work")
            .sort((a, b) => b.number - a.number)[0];
          if (!latest)
            throw new HttpError(
              409,
              "No preceding work run is available. Specify the workflow to capture.",
            );
          sourceRunIds = [latest.id];
        }
      }
      for (const id of sourceRunIds)
        if (!runs.summaries.has(id))
          throw new HttpError(
            409,
            "A selected source run is unavailable in this host history.",
          );
      sourceRunIds = [...new Set(sourceRunIds)].sort(
        (a, b) => runs.summaries.get(a)!.number - runs.summaries.get(b)!.number,
      );
      if (
        data.destinationSkillId !== undefined &&
        (typeof data.destinationSkillId !== "string" ||
          !skills
            .snapshot()
            .skills.some(
              (s) => s.id === data.destinationSkillId && s.source === "user",
            ))
      )
        throw new HttpError(
          409,
          "The destination user skill is unavailable. Refresh the skills browser.",
        );
      sourceRunIds.forEach((id) => runs.protected.add(id));
      try {
        await runs.prepare();
      } catch (error) {
        sourceRunIds.forEach((id) => runs.protected.delete(id));
        throw new HttpError(409, (error as Error).message);
      }
      state.messages = state.messages.filter(
        (m) =>
          !m.runId || runs.summaries.get(m.runId)?.detailsAvailable !== false,
      );
      state.operations = state.operations.filter(
        (op) =>
          !op.runId ||
          !terminal.has(op.status) ||
          runs.summaries.get(op.runId)?.detailsAvailable !== false,
      );
      const runId = randomUUID();
      const response = { requestId: data.requestId, runId };
      state.requests[data.requestId] = { fingerprint, response };
      const history = [...state.messages];
      const userMessage: Message = {
        id: randomUUID(),
        role: "user",
        text: data.text,
        runId,
      };
      state.messages.push(userMessage);
      const message: Message = {
        id: randomUUID(),
        role: "assistant",
        text: "",
        runId,
      };
      state.messages.push(message);
      const run: RunDetail = {
        run: {
          id: runId,
          instanceId: options.instanceId,
          number: runs.nextNumber,
          requestId: data.requestId,
          userMessageId: userMessage.id,
          assistantMessageId: message.id,
          promptPreview: data.text,
          startedAt: new Date().toISOString(),
          status: "running",
          intent: authoring ? "authoring" : "work",
          mode: authoring ? "authoring" : "execution",
          sourceRunIds,
          provider: state.settings.provider,
          model: state.settings.model,
          toolNames: [],
          failedCalls: 0,
          callCount: 0,
          detailsAvailable: true,
        },
        calls: [],
        messages: [userMessage, message],
        operations: [],
        context: context ? structuredClone(context) : undefined,
        catalogSnapshot: skillSnapshot.id,
        selectedSkills: skillSnapshot.selected.map((s) => ({
          id: s.id,
          revision: s.revision,
        })),
        readSkills: [],
      };
      run.availableSkills = skillSnapshot.library.skills
        .filter((s) => skillSnapshot.catalog.some((c) => c.filePath === s.path))
        .map((s) => ({ id: s.id, revision: s.revision, name: s.name }));
      activeRun = run;
      const controller = new AbortController();
      turnAbort = controller;
      chatBusy = true;
      try {
        await runs.save(run);
        await persist();
      } catch (error) {
        delete state.requests[data.requestId];
        state.messages = state.messages.filter((m) => m.runId !== runId);
        activeRun = undefined;
        chatBusy = false;
        turnAbort = undefined;
        sourceRunIds.forEach((id) => runs.protected.delete(id));
        storageError =
          "Run acceptance could not be saved. Check the data directory and restart the host before retrying.";
        await runs.discardUnaccepted(runId).catch(() => {});
        broadcast();
        throw new HttpError(503, storageError);
      }
      send(res, 202, response);
      broadcast();
      if (controller.signal.aborted || submissionEpoch !== cancellationEpoch) {
        message.text = "Cancelled before the agent started.";
        run.run.status = "interrupted";
        run.run.endedAt = new Date().toISOString();
        try {
          await runs.save(run);
          await persist();
        } catch {
          storageError =
            "Cancelled run could not be saved. Check the data directory and restart the host.";
        } finally {
          activeRun = undefined;
          sourceRunIds.forEach((id) => runs.protected.delete(id));
          chatBusy = false;
          turnAbort = undefined;
          broadcast();
        }
        return;
      }
      const boundContext = structuredClone(
        context ?? {
          instanceId: options.instanceId,
          revitVersion: "unavailable",
          revitBuild: "unavailable",
          runtime: "unavailable",
          document: null,
        },
      );
      const desktopTools = authoring
        ? undefined
        : desktop.beginTurn(boundContext.document?.token ?? null);
      const withTurnSignal = (signal?: AbortSignal) =>
        signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;
      const turnId = randomUUID();
      void options.agent
        .prompt(
          data.text,
          state.settings,
          boundContext,
          history,
          async (input, signal) => {
            if (authoring)
              throw new Error(
                "Native execution is unavailable in skill authoring mode.",
              );
            if (context?.document?.token !== boundContext.document?.token)
              throw new Error(
                "Active document changed during this turn. Start a new turn.",
              );
            return execute(input, withTurnSignal(signal));
          },
          (text) => {
            message.text = text.slice(0, 200000);
            broadcast();
          },
          desktopTools
            ? {
                observe: (input, signal) =>
                  desktopTools.observe(input, withTurnSignal(signal)),
                action: (id, input, signal) =>
                  desktopTools.action(
                    `${turnId}:${id}`,
                    input,
                    withTurnSignal(signal),
                  ),
              }
            : undefined,
          {
            mode: authoring ? "authoring" : "execution",
            library: skills,
            skills: skillSnapshot,
            sourceRunReferences: sourceRunIds.map((id) => ({
              instanceId: options.instanceId,
              runId: id,
              number: runs.summaries.get(id)!.number,
            })),
            destinationSkillId: data.destinationSkillId,
            withToolCall: (id, work) => toolScope.run(id, work),
            onSkillRead: (evidence) => {
              const record = {
                id: evidence.id,
                revision: evidence.revision,
                path: evidence.path,
                offset: evidence.offset,
                complete: evidence.complete,
              };
              if (evidence.authoring) (run.authoringReads ??= []).push(record);
              else run.readSkills!.push(record);
            },
            onToolEvent: async (event) => {
              if (closing) return;
              if (event.type === "start") await runs.prepare();
              if (
                event.type === "start" &&
                (run.run.detailBytes ?? 0) >
                  HISTORY_LIMITS.detailBytes - HISTORY_LIMITS.resultBytes
              )
                throw new Error(
                  "Run detail budget reached. Recovery evidence retained; start a new run.",
                );
              if (event.type === "start") {
                run.calls.push({
                  id: event.id,
                  runId,
                  name: event.name,
                  sequence: run.calls.length + 1,
                  arguments: bounded(event.arguments),
                  startedAt: new Date().toISOString(),
                  status: "running",
                  operationIds: [],
                  artifacts: [],
                });
              } else {
                const call = run.calls.find((c) => c.id === event.id);
                if (call) {
                  const operations = run.operations.filter((op) =>
                    call.operationIds.includes(op.operationId),
                  );
                  call.status = operations.some((op) => op.status === "unknown")
                    ? "unknown"
                    : event.isError ||
                        operations.some((op) =>
                          ["failed", "cancelled"].includes(op.status),
                        )
                      ? "failed"
                      : "succeeded";
                  call.endedAt = new Date().toISOString();
                  call.result = event.name.startsWith("history_")
                    ? {
                        sourceRecord: bounded(call.arguments),
                        notice: "Use history tools to read source evidence.",
                      }
                    : await runs.result(event.result, run, call.artifacts);
                  if (call.status !== "succeeded")
                    call.error =
                      typeof event.result === "string"
                        ? event.result.slice(0, 4096)
                        : "Tool failed or its native outcome is uncertain; see result.";
                }
              }
              await runs.save(run);
              broadcast();
            },
            historyTools: [
              {
                name: "history_list",
                label: "Search recorded runs",
                description:
                  "Search retained runs in this host history. Run completion does not prove native success.",
                parameters: Type.Object({
                  search: Type.Optional(Type.String()),
                  cursor: Type.Optional(Type.String()),
                }),
                execute: async (_id, input: any) => ({
                  content: [
                    { type: "text", text: JSON.stringify(runs.list(input)) },
                  ],
                  details: {},
                }),
              },
              {
                name: "history_read",
                label: "Read recorded run",
                description: `Read recorded evidence with provenance. Explicit source runs: ${JSON.stringify(sourceRunIds.map((id) => ({ instanceId: options.instanceId, runId: id, number: runs.summaries.get(id)!.number })))}. Destination skill: ${data.destinationSkillId ?? "none"}. Missing/truncated evidence must be disclosed; never present unverified work as success.`,
                parameters: Type.Object({
                  runId: Type.String(),
                  offset: Type.Optional(Type.Integer({ minimum: 0 })),
                  limit: Type.Optional(
                    Type.Integer({ minimum: 1, maximum: 16000 }),
                  ),
                }),
                execute: async (_id, input: any) => {
                  const detail = await runs.detail(input.runId);
                  const text = JSON.stringify(detail);
                  const offset = input.offset ?? 0,
                    end = offset + (input.limit ?? 16000);
                  return {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          instanceId: options.instanceId,
                          runId: input.runId,
                          offset,
                          totalCharacters: text.length,
                          truncated: end < text.length,
                          evidence: text.slice(offset, end),
                        }),
                      },
                    ],
                    details: { runId: input.runId },
                  };
                },
              },
            ],
          },
        )
        .then(() => {
          controller.signal.throwIfAborted();
          run.run.status = "finished";
        })
        .catch((error) => {
          run.run.status = controller.signal.aborted ? "interrupted" : "failed";
          const interruption = controller.signal.reason;
          const reason =
            controller.signal.aborted &&
            interruption instanceof Error &&
            interruption.name !== "AbortError"
              ? (desktop.snapshot().error ?? interruption.message)
              : error instanceof Error
                ? error.message
                : "Agent failed";
          message.text += `\n${reason}`;
        })
        .finally(async () => {
          if (closing) return;
          if (!authoring)
            try {
              await desktop.endTurn();
            } catch {
              /* Helper disconnect is already fenced. */
            }
          run.run.endedAt = new Date().toISOString();
          for (const call of run.calls)
            if (call.status === "running") {
              call.status = "unknown";
              call.error = "Run ended before a confirmed tool result.";
            }
          try {
            await runs.save(run);
            run.messages.forEach((m) => archivedMessages.add(m.id));
            run.operations
              .filter((o) => terminal.has(o.status))
              .forEach((o) => archivedOperations.add(o.operationId));
            await persist();
          } catch {
            storageError =
              "Run history could not be saved. Recovery evidence may be incomplete; check the data directory and restart the host.";
            message.text += `\n${storageError}`;
          } finally {
            sourceRunIds.forEach((id) => runs.protected.delete(id));
            activeRun = undefined;
            chatBusy = false;
            turnAbort = undefined;
            broadcast();
          }
        })
        .catch(() => {
          storageError =
            "Run finalization failed. Restart the host after checking its data directory.";
          chatBusy = false;
          broadcast();
        });
      return;
    }
    throw new HttpError(404, "Not found.");
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(url).host)
        throw new HttpError(403, "Invalid Host.");
      if (req.headers.origin && req.headers.origin !== url)
        throw new HttpError(403, "Invalid Origin.");
      const requestUrl = new URL(req.url ?? "/", url);
      const path = requestUrl.pathname;
      if (path.startsWith("/api/")) {
        if (!matchesSecret(req.headers.authorization, `Bearer ${browserToken}`))
          throw new HttpError(401, "Unauthorized.");
        if (req.method === "GET" && path === "/api/state") {
          send(res, 200, snapshot());
          return;
        }
        if (req.method === "GET" && path === "/api/console-draft") {
          send(res, 200, { draft: consoleDraft });
          return;
        }
        if (req.method === "GET" && path === "/api/skills") {
          await skills.refresh();
          send(res, 200, skills.snapshot());
          return;
        }
        if (req.method === "GET" && path.startsWith("/api/skills/")) {
          const parts = path.slice("/api/skills/".length).split("/");
          const id = decodeURIComponent(parts[0]!);
          try {
            await skills.refresh();
            send(
              res,
              200,
              parts[1] === "revisions"
                ? await skills.revisions(id)
                : skills.preview(id),
            );
          } catch (error) {
            throw new HttpError(404, (error as Error).message);
          }
          return;
        }
        if (req.method === "GET" && path === "/api/runs") {
          const query = requestUrl.searchParams;
          try {
            send(
              res,
              200,
              runs.list({
                search: query.get("search") ?? undefined,
                errorsOnly: query.get("errorsOnly") === "true",
                tool: query.get("tool") ?? undefined,
                cursor: query.get("cursor") ?? undefined,
              }),
            );
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
          return;
        }
        if (req.method === "GET" && path.startsWith("/api/runs/")) {
          try {
            send(
              res,
              200,
              await runs.detail(
                decodeURIComponent(path.slice("/api/runs/".length)),
              ),
            );
          } catch (error) {
            throw new HttpError(404, (error as Error).message);
          }
          return;
        }
        if (req.method === "GET" && path.startsWith("/api/history/image/")) {
          try {
            const content = await runs.image(
              path.slice("/api/history/image/".length),
            );
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            });
            res.end(content);
          } catch {
            throw new HttpError(404, "Image unavailable or expired.");
          }
          return;
        }
        if (req.method === "GET" && path === "/api/history/legacy") {
          const query = requestUrl.searchParams;
          const records = state.operations.filter((o) => !o.runId);
          const before = Number(query.get("before") ?? records.length);
          send(res, 200, {
            operations: records.slice(Math.max(0, before - 50), before),
            nextCursor: before > 50 ? String(before - 50) : undefined,
            notice:
              "Older history and manual console operations have no inferred message association.",
          });
          return;
        }
        if (req.method === "GET" && path.startsWith("/api/desktop/image/")) {
          const content = await desktop.image(
            path.slice("/api/desktop/image/".length),
          );
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(content);
          return;
        }
        if (req.method === "GET" && path === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          events.add(res);
          res.on("close", () => events.delete(res));
          res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
          return;
        }
        if (req.method !== "POST") throw new HttpError(404, "Not found.");
        // Stop and read-only capture must not wait behind native mutation/disk work.
        if (path === "/api/cancel" || path === "/api/desktop/stop") {
          ++cancellationEpoch;
          turnAbort?.abort();
          void desktop.stop().catch(() => {});
          for (const op of state.operations)
            if (!terminal.has(op.status))
              dispatch({ kind: "cancel", operationId: op.operationId });
          void options.agent.abort().catch(() => {});
          send(res, 200, { ok: true });
          return;
        }
        if (path === "/api/desktop/observe") {
          const input = await body(req);
          try {
            const { data: _, ...evidence } =
              await desktop.observePassive(input);
            send(res, 200, evidence);
          } catch (error) {
            send(res, 409, { error: (error as Error).message });
          }
          return;
        }
        const submissionEpoch = cancellationEpoch;
        const work = mutationChain.then(() =>
          mutate(req, res, path, submissionEpoch),
        );
        mutationChain = work.catch(() => {});
        await work;
        return;
      }
      if (req.method !== "GET") throw new HttpError(405, "Method not allowed.");
      const root = resolve(options.webDir);
      const file = resolve(
        root,
        "." + decodeURIComponent(path === "/" ? "/index.html" : path),
      );
      if (!file.startsWith(root + sep))
        throw new HttpError(403, "Invalid path.");
      const [realRoot, realFile] = await Promise.all([
        realpath(root),
        realpath(file),
      ]).catch(() => {
        throw new HttpError(404, "UI asset not found. Run npm run build.");
      });
      // Static assets are public. A junction/symlink must not expose files outside
      // the installed web directory. Read the resolved target after checking it.
      const assetPath = relative(realRoot, realFile);
      if (
        !assetPath ||
        assetPath === ".." ||
        assetPath.startsWith(".." + sep) ||
        isAbsolute(assetPath)
      )
        throw new HttpError(403, "Invalid path.");
      const content = await readFile(realFile).catch(() => {
        throw new HttpError(404, "UI asset not found. Run npm run build.");
      });
      const types: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'",
      });
      res.end(content);
    } catch (error) {
      if (!res.headersSent)
        send(res, error instanceof HttpError ? error.status : 500, {
          error:
            error instanceof HttpError
              ? error.message
              : "Internal host error. Check installation and data directory.",
        });
      else res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  void (async () => {
    try {
      for await (const frames of router) {
        if (frames.length !== 2) continue;
        const [route, frame] = frames;
        try {
          const envelope = JSON.parse(frame!.toString());
          if (!matchesSecret(envelope.token, options.nativeToken)) continue;
          const data = envelope.payload;
          const work = mutationChain.then(async () => {
            if (envelope.type === "context") {
              if (
                data?.instanceId !== options.instanceId ||
                (data.document !== null &&
                  typeof data.document?.token !== "string")
              )
                return;
              if (
                chatBusy &&
                activeRun?.run.mode !== "authoring" &&
                context?.document?.token !== data.document?.token
              ) {
                turnAbort?.abort();
                void desktop.stop().catch(() => {});
                void options.agent.abort().catch(() => {});
              }
              context = data;
              lastHeartbeat = Date.now();
              nativeRoute = route;
              while (queue.length) dispatch(queue.shift()!);
              broadcast();
            } else if (envelope.type === "disconnect") {
              await markDisconnected();
            } else if (envelope.type === "operation") {
              const op = state.operations.find(
                (o) => o.operationId === data?.operationId,
              );
              if (!op || !statuses.has(data.status)) return;
              if (!terminal.has(op.status)) {
                for (const key of [
                  "status",
                  "result",
                  "logs",
                  "diagnostics",
                  "error",
                  "transactionStatus",
                  "elapsedMs",
                ] as const)
                  if (data[key] !== undefined) (op as any)[key] = data[key];
                if (activeRun && activeRun.run.id === op.runId)
                  await runs.save(activeRun);
                else if (
                  op.runId &&
                  runs.summaries.get(op.runId)?.detailsAvailable
                ) {
                  const detail = await runs.detail(op.runId);
                  const index = detail.operations.findIndex(
                    (o) => o.operationId === op.operationId,
                  );
                  if (index >= 0) detail.operations[index] = op;
                  await runs.save(detail);
                  if (terminal.has(op.status))
                    archivedOperations.add(op.operationId);
                } else if (terminal.has(op.status)) {
                  const file = resolve(
                    manualDirectory,
                    `${op.operationId}.json`,
                  );
                  await writeFile(`${file}.tmp`, JSON.stringify(op), {
                    mode: 0o600,
                  });
                  await rename(`${file}.tmp`, file);
                  archivedOperations.add(op.operationId);
                }
                await persist();
                broadcast();
                if (terminal.has(op.status) || op.status === "unknown") {
                  waiters.get(op.operationId)?.resolve(op);
                  waiters.delete(op.operationId);
                }
              }
              sendChain = sendChain
                .then(() =>
                  router.send([
                    route!,
                    JSON.stringify({
                      type: "ack",
                      operationId: op.operationId,
                      status: op.status,
                    }),
                  ]),
                )
                .catch(() => {});
            }
          });
          mutationChain = work.catch(() => {});
          await work;
        } catch {
          /* Malformed authenticated native frame is ignored, never dispatched. */
        }
      }
    } catch {
      /* Socket closes during host shutdown. */
    }
  })();
  const heartbeat = setInterval(() => {
    const work = mutationChain.then(async () => {
      if (lastHeartbeat && !connected()) await markDisconnected();
    });
    mutationChain = work.catch(() => {});
  }, 1000);
  heartbeat.unref();
  return {
    url,
    nativeEndpoint,
    browserToken,
    snapshot,
    close: async () => {
      closing = true;
      authController?.abort();
      turnAbort?.abort();
      clearInterval(heartbeat);
      clearTimeout(broadcastTimer);
      for (const waiter of waiters.values())
        waiter.reject(new Error("Host closed"));
      await options.agent.abort();
      await desktop.close().catch(() => {});
      for (const res of events) res.end();
      router.close();
      await mutationChain;
      if (activeRun) {
        activeRun.run.status = "interrupted";
        activeRun.run.endedAt = new Date().toISOString();
        for (const call of activeRun.calls)
          if (call.status === "running") {
            call.status = "unknown";
            call.error = "Host closed before a confirmed tool result.";
          }
        await runs.save(activeRun);
      }
      await runs.flush();
      await saveChain;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
