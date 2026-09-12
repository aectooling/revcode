import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import {
  ProviderDialog,
  type Provider,
  type AuthState,
} from "./provider-dialog";

type Mode = "query" | "modify";
type Operation = {
  operationId: string;
  code: string;
  mode: Mode;
  status: string;
  createdAt: string;
  result?: unknown;
  error?: string;
  logs?: string[];
  transactionStatus?: string;
  elapsedMs?: number;
  diagnostics?: {
    severity: string;
    message: string;
    line?: number;
    column?: number;
  }[];
};
type HostState = {
  instanceId: string;
  connected: boolean;
  busy: boolean;
  context: null | {
    revitVersion: string;
    revitBuild: string;
    runtime: string;
    document: null | {
      token: string;
      title: string;
      isFamily: boolean;
      isReadOnly: boolean;
      activeView: string;
      selection: string[];
    };
  };
  messages: {
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
  }[];
  operations: Operation[];
  settings: { provider: string; model: string; configured: boolean };
  providers: Provider[];
  auth?: AuthState;
};

const examples: { label: string; mode: Mode; code: string }[] = [
  {
    label: "Query levels",
    mode: "query",
    code: `return new FilteredElementCollector(ctx.Doc)
    .OfClass(typeof(Level))
    .Cast<Level>()
    .Select(level => new {
        id = level.UniqueId,
        name = level.Name,
        elevationMm = UnitUtils.ConvertFromInternalUnits(
            level.Elevation, UnitTypeId.Millimeters)
    })
    .ToArray();`,
  },
  {
    label: "Create level",
    mode: "modify",
    code: `ctx.CheckCancellation();
var elevation = UnitUtils.ConvertToInternalUnits(3000, UnitTypeId.Millimeters);
var level = Level.Create(ctx.Doc, elevation);
ctx.Log("Created level at 3000 mm.");
return new { id = level.UniqueId, name = level.Name };`,
  },
  {
    label: "Test rollback",
    mode: "modify",
    code: `var elevation = UnitUtils.ConvertToInternalUnits(4500, UnitTypeId.Millimeters);
var level = Level.Create(ctx.Doc, elevation);
ctx.Log("Created a temporary level; the exception should roll it back.");
throw new InvalidOperationException("Intentional rollback test. No level should remain.");`,
  },
];

function readToken() {
  const fragment = window.location.hash.slice(1);
  if (fragment) {
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    try {
      window.sessionStorage.setItem("revcode.token", fragment);
    } catch {
      /* memory still works */
    }
    return fragment;
  }
  try {
    return window.sessionStorage.getItem("revcode.token") || "";
  } catch {
    return "";
  }
}
let token = readToken();

async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : typeof data.message === "string"
          ? data.message
          : `Request failed (${response.status}).`,
    );
  return data as T;
}

function App() {
  const [activeToken, setActiveToken] = useState(token);
  const [state, setState] = useState<HostState | null>(null);
  const [hostOnline, setHostOnline] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"chat" | "console">("chat");
  const [prompt, setPrompt] = useState("");
  const [code, setCode] = useState(examples[0].code);
  const [mode, setMode] = useState<Mode>("query");
  const [pending, setPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);

  useEffect(() => {
    const reconnect = () => {
      if (!window.location.hash) return;
      token = readToken();
      setActiveToken(token);
    };
    window.addEventListener("hashchange", reconnect);
    return () => window.removeEventListener("hashchange", reconnect);
  }, []);

  useEffect(() => {
    if (!activeToken) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await api<HostState>(
          "/api/state",
          undefined,
          controller.signal,
        );
        if (!disposed) {
          setState(next);
          setHostOnline(true);
          setConnectionError("");
        }
      } catch (reason) {
        if (!disposed) {
          setHostOnline(false);
          setConnectionError(
            reason instanceof Error
              ? reason.message
              : "Unable to reach the local host.",
          );
        }
      } finally {
        if (!disposed) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeToken]);

  const lastMessage = state?.messages.at(-1);
  useEffect(() => {
    const element = transcript.current;
    if (
      element &&
      element.scrollHeight - element.scrollTop - element.clientHeight < 220
    ) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lastMessage?.text, state?.messages.length]);

  const doc = state?.context?.document;
  const ready = hostOnline && !!state?.connected && !!doc;
  const busy = pending || !!state?.busy;
  const unknown = state?.operations.some(
    (operation) => operation.status === "unknown",
  );
  const canExecute = ready && !busy && !unknown;
  const operations = [...(state?.operations || [])].reverse();
  function openSettings() {
    setSettingsOpen(true);
  }

  async function submit(kind: "chat" | "execute") {
    if (
      submitting.current ||
      !canExecute ||
      (kind === "chat" && !state?.settings.configured)
    )
      return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await api(
        `/api/${kind}`,
        kind === "chat"
          ? { requestId: crypto.randomUUID(), text: prompt.trim() }
          : {
              requestId: crypto.randomUUID(),
              code,
              mode,
              transactionName: "Revcode: C# console",
            },
      );
      if (kind === "chat") setPrompt("");
      setState(await api<HostState>("/api/state"));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Request failed. Check operation history before submitting again.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  async function cancel() {
    setError("");
    try {
      await api("/api/cancel", {});
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not request cancellation.",
      );
    }
  }

  if (!token)
    return (
      <main className="launch-page">
        <div className="brand-mark">r/</div>
        <h1>Open Revcode from Revit</h1>
        <p>
          Click the Revcode ribbon button to connect this browser to your Revit
          session.
        </p>
        <p className="muted">
          The ribbon supplies a private connection token for this tab.
        </p>
      </main>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => event.preventDefault()}
          aria-label="Revcode workspace"
        >
          <span className="brand-mark">r/</span>
          <span>
            revcode<span className="brand-caption">YOUR REVIT WORKSPACE</span>
          </span>
        </a>
        <div className="sidebar-section-label">CONNECTION</div>
        <div className="connection">
          <span className={`status-dot ${ready ? "online" : ""}`} />
          <strong>
            {!hostOnline
              ? "Connecting to host"
              : state?.connected
                ? "Revit connected"
                : "Waiting for Revit"}
          </strong>
        </div>
        {state?.context && (
          <p className="version">
            Revit {state.context.revitVersion}
            <br />
            <span>Build {state.context.revitBuild}</span>
          </p>
        )}
        <div className="document-card">
          <span className="eyebrow">ACTIVE DOCUMENT</span>
          <h2>{doc?.title || "No document open"}</h2>
          <p>
            {doc
              ? `${doc.isFamily ? "Family" : "Project"}${doc.isReadOnly ? " · Read only" : ""}`
              : "Open a project or family in Revit."}
          </p>
          {doc && (
            <>
              <div className="document-rule" />
              <span className="eyebrow">VIEW</span>
              <p className="view-name">{doc.activeView || "—"}</p>
              <span className="selection-count">
                {doc.selection.length} selected elements
              </span>
            </>
          )}
        </div>
        <nav aria-label="Workspace">
          <button
            className={`nav-item ${tab === "chat" ? "active" : ""}`}
            onClick={() => setTab("chat")}
          >
            <span aria-hidden="true">↗</span> Assistant
          </button>
          <button
            className={`nav-item ${tab === "console" ? "active" : ""}`}
            onClick={() => setTab("console")}
          >
            <span aria-hidden="true">⌘</span> C# console
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="provider-button" onClick={openSettings}>
            <span
              className={`status-dot ${state?.settings.configured ? "online" : ""}`}
            />
            <span>
              {state?.settings.configured
                ? state.settings.provider
                : "Set up a provider"}
              <small>
                {state?.settings.configured
                  ? state.settings.model
                  : "Connect a model to Pi"}
              </small>
            </span>
            <span aria-hidden="true">⚙</span>
          </button>
          <p>Local host · Powered by Pi</p>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">
              REVCODE / {tab === "chat" ? "ASSISTANT" : "DEVELOPER"}
            </span>
            <h1>
              {tab === "chat"
                ? "Build with your model."
                : "A direct line to Revit."}
            </h1>
          </div>
          <span className={`activity-pill ${busy ? "working" : ""}`}>
            {busy ? "● Working" : ready ? "● Ready" : "○ Not connected"}
          </span>
        </header>
        {(!hostOnline || !state?.connected) && (
          <div className="notice" role="status">
            {connectionError ||
              "Waiting for the Revit add-in to connect. Open Revcode from the Revit ribbon."}{" "}
            <span>
              Reconnecting automatically. Commands are never replayed.
            </span>
          </div>
        )}
        {unknown && (
          <div className="notice error" role="alert">
            An operation has an unknown outcome. Further execution is paused
            until Revit reports its result. Inspect the model before taking
            further action.
          </div>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}

        {tab === "chat" ? (
          <section className="chat-panel" aria-label="Assistant">
            <div
              className="transcript"
              ref={transcript}
              role="log"
              aria-label="Conversation"
            >
              {!state?.messages.length && (
                <div className="empty-state">
                  <span className="empty-symbol" aria-hidden="true">
                    ⌁
                  </span>
                  <span className="eyebrow">FROM INTENT TO ELEMENTS</span>
                  <h2>
                    What would you like
                    <br />
                    to do in Revit?
                  </h2>
                  <p>
                    Ask the assistant to inspect your model or make a change.
                    Every C# operation appears in the execution history.
                  </p>
                  <div className="suggestions">
                    {[
                      "List the levels and their elevations.",
                      "Tell me about the selected elements.",
                    ].map((text) => (
                      <button key={text} onClick={() => setPrompt(text)}>
                        {text}
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {state?.messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span className="message-author">
                    {message.role === "assistant"
                      ? "Revcode"
                      : message.role === "user"
                        ? "You"
                        : "System"}
                  </span>
                  <div className="message-text">{message.text || "…"}</div>
                </article>
              ))}
            </div>
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void submit("chat");
              }}
            >
              {!state?.settings.configured && (
                <div className="setup-hint">
                  <button type="button" onClick={openSettings}>
                    Connect a provider
                  </button>{" "}
                  to use the assistant, or{" "}
                  <button type="button" onClick={() => setTab("console")}>
                    test the C# console
                  </button>{" "}
                  without credentials.
                </div>
              )}
              <label htmlFor="prompt" className="sr-only">
                Message the assistant
              </label>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe a change, or ask about your model…"
                rows={3}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (prompt.trim()) void submit("chat");
                  }
                }}
              />
              <div className="composer-footer">
                <span>Enter to send · Shift + Enter for a new line</span>
                {busy ? (
                  <button
                    type="button"
                    className="stop-button"
                    disabled={pending}
                    onClick={() => void cancel()}
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    disabled={
                      !canExecute ||
                      !state?.settings.configured ||
                      !prompt.trim()
                    }
                  >
                    Send <span aria-hidden="true">↑</span>
                  </button>
                )}
              </div>
            </form>
          </section>
        ) : (
          <section className="console-panel" aria-label="C# console">
            <div className="console-intro">
              <h2>Run a C# method body</h2>
              <p>
                The same executor the assistant uses. No model or API key
                required. Access the current document through{" "}
                <code>ctx.Doc</code>.
              </p>
            </div>
            <div className="example-buttons">
              {examples.map((example) => (
                <button
                  key={example.label}
                  onClick={() => {
                    setCode(example.code);
                    setMode(example.mode);
                  }}
                >
                  {example.label}
                </button>
              ))}
            </div>
            <div className="editor-header">
              <label htmlFor="code">snippet.cs</label>
              <span>object? Execute(RevcodeContext ctx)</span>
            </div>
            <textarea
              className="code-editor"
              id="code"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  if (code.trim()) void submit("execute");
                }
              }}
            />
            <div className="console-actions">
              <label>
                Execution mode
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as Mode)}
                >
                  <option value="query">Query · no transaction</option>
                  <option value="modify">Modify · one transaction</option>
                </select>
              </label>
              {busy ? (
                <button
                  className="stop-button"
                  disabled={pending}
                  onClick={() => void cancel()}
                >
                  Stop
                </button>
              ) : (
                <button
                  className="primary-button"
                  disabled={
                    !canExecute ||
                    !code.trim() ||
                    (mode === "modify" && doc?.isReadOnly)
                  }
                  onClick={() => void submit("execute")}
                >
                  Run C# <span aria-hidden="true">↗</span>
                </button>
              )}
            </div>
            <p className="console-note">
              Ctrl + Enter to run. Modify calls create a Revit Undo entry when
              committed. Stop is cooperative; running code must call{" "}
              <code>ctx.CheckCancellation()</code>.
            </p>
          </section>
        )}
        <section className="operations" aria-label="Execution history">
          <div className="section-heading">
            <h2>Execution history</h2>
            <span>{operations.length} operations</span>
          </div>
          {operations.length === 0 ? (
            <p className="history-empty">
              Code, diagnostics, and transaction outcomes will appear here after
              execution.
            </p>
          ) : (
            operations.map((operation) => (
              <details
                className="operation"
                key={operation.operationId}
                open={
                  operation.status === "failed" ||
                  operation.status === "unknown" ||
                  !["succeeded", "cancelled"].includes(operation.status)
                }
              >
                <summary>
                  <span className={`operation-status ${operation.status}`}>
                    {operation.status === "queued"
                      ? "Waiting for Revit"
                      : operation.status}
                  </span>
                  <span className="operation-name">
                    {operation.mode === "modify"
                      ? "Model change"
                      : "Model query"}
                  </span>
                  <span className="operation-time">
                    {operation.elapsedMs !== undefined
                      ? `${(operation.elapsedMs / 1000).toFixed(2)}s`
                      : ""}
                  </span>
                </summary>
                <div className="operation-body">
                  <p className="operation-id">
                    {operation.operationId}
                    {operation.transactionStatus
                      ? ` · Transaction: ${operation.transactionStatus}`
                      : ""}
                  </p>
                  <pre>
                    <code>{operation.code}</code>
                  </pre>
                  {operation.error && (
                    <p className="operation-error">{operation.error}</p>
                  )}
                  {operation.diagnostics?.map((diagnostic, index) => (
                    <p key={index} className="diagnostic">
                      <strong>{diagnostic.severity}</strong>
                      {diagnostic.line
                        ? ` · line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}`
                        : ""}
                      : {diagnostic.message}
                    </p>
                  ))}
                  {!!operation.logs?.length && (
                    <>
                      <h3>Logs</h3>
                      <pre>{operation.logs.join("\n")}</pre>
                    </>
                  )}
                  {operation.result !== undefined && (
                    <>
                      <h3>Result</h3>
                      <pre>{JSON.stringify(operation.result, null, 2)}</pre>
                    </>
                  )}
                </div>
              </details>
            ))
          )}
        </section>
      </main>

      {settingsOpen && state && (
        <ProviderDialog
          providers={state.providers}
          auth={state.auth}
          selected={state.settings}
          api={api}
          refresh={async () => {
            setState(await api<HostState>("/api/state"));
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
