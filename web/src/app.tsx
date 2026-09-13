import { CircleAlert, KeyRound, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Composer } from "./components/composer";
import { ConsolePanel } from "./components/console-panel";
import { OperationsPanel } from "./components/operations-panel";
import { Sidebar } from "./components/sidebar";
import { Welcome } from "./components/welcome";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/tooltip";
import { cn, providerLabel } from "./lib/utils";
import {
  ProviderDialog,
  type Provider,
  type AuthState,
} from "./provider-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

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

const SIDEBAR_KEY = "revcode.sidebar.collapsed";

function readCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

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

function StatusPill({ ready, busy }: { ready: boolean; busy: boolean }) {
  if (busy)
    return (
      <Badge
        variant="accent"
        dot
        pulse
        className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal"
      >
        <span className="text-ink">Working</span>
      </Badge>
    );
  if (ready)
    return (
      <Badge
        variant="accent"
        dot
        className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal"
      >
        <span className="text-ink">Ready</span>
      </Badge>
    );
  return (
    <Badge
      variant="neutral"
      className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal"
    >
      <span className="text-ink">Not connected</span>
    </Badge>
  );
}

export function App() {
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readCollapsed);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      /* preference only */
    }
  }, [sidebarCollapsed]);

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

  if (!token) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-canvas px-6">
        <div className="w-full max-w-md animate-slide-up">
          <h1 className="text-[22px] font-semibold tracking-tight">
            <span className="text-accent-hover">Rev</span>code
          </h1>
          <h2 className="mt-4 text-lg font-medium">Open Revcode from Revit</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
            Click the Revcode ribbon button to connect this browser to your Revit
            session.
          </p>
          <p className="mt-2 text-xs text-muted">
            The ribbon supplies a private connection token for this tab.
          </p>
        </div>
      </main>
    );
  }

  const title = tab === "chat" ? "Assistant" : "C# console";
  const connectionDetail =
    connectionError ||
    (!state?.connected
      ? "Waiting for the Revit add-in to connect."
      : "Connected to the local host.");

  const modelControls =
    state && tab === "chat" ? (
      state.settings.configured ? (
        <Select
          value={`${state.settings.provider}/${state.settings.model}`}
          onValueChange={(value) => {
            const [provider, ...rest] = value.split("/");
            if (provider && rest.length) {
              void api("/api/settings", {
                provider,
                model: rest.join("/"),
              }).then(() => api<HostState>("/api/state").then(setState));
            }
          }}
        >
          <SelectTrigger
            aria-label="Model"
            className="h-7 w-auto max-w-[176px] min-w-0 gap-1.5 border-transparent bg-transparent px-2 text-xs font-medium text-ink-soft hover:border-transparent hover:bg-ink/[.06] hover:text-ink"
          >
            <SelectValue>
              {providerLabel(state.settings.provider, state.providers)} ·{" "}
              {state.settings.model}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {state.providers.flatMap((provider) =>
              provider.models.map((model) => (
                <SelectItem
                  key={`${provider.id}/${model.id}`}
                  value={`${provider.id}/${model.id}`}
                >
                  {provider.name || provider.id} · {model.name || model.id}
                </SelectItem>
              )),
            )}
          </SelectContent>
        </Select>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="font-semibold text-ink-soft"
          onClick={() => setSettingsOpen(true)}
        >
          <KeyRound className="size-3.5" />
          Connect a provider
        </Button>
      )
    ) : null;

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink lg:flex-row">
        <a className="skip-link" href="#composer-input">
          Skip to message
        </a>
        <Sidebar
          tab={tab}
          onTabChange={setTab}
          connected={hostOnline}
          hostOnline={hostOnline}
          revitConnected={!!state?.connected}
          connectionDetail={connectionDetail}
          revitVersion={state?.context?.revitVersion}
          revitBuild={state?.context?.revitBuild}
          document={doc}
          provider={state?.settings.provider}
          model={state?.settings.model}
          providers={state?.providers ?? []}
          providerConfigured={!!state?.settings.configured}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          mobileOpen={mobileSettingsOpen}
          onMobileOpenChange={setMobileSettingsOpen}
          onManageProvider={() => setSettingsOpen(true)}
          onReconnect={() => window.location.reload()}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="relative flex h-11 shrink-0 items-center gap-2 border-b border-line px-4 sm:px-6">
            <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">
              {title}
            </h1>
            <StatusPill ready={ready} busy={busy} />
          </header>

          {(!hostOnline || !state?.connected) && (
            <div
              role="status"
              className="flex items-start gap-2 border-b border-warn/30 bg-warn-soft px-4 py-2 text-[13px] text-warn sm:px-6"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                {connectionError ||
                  "Waiting for the Revit add-in to connect. Open Revcode from the Revit ribbon."}{" "}
                <span className="opacity-80">
                  Reconnecting automatically. Commands are never replayed.
                </span>
              </span>
            </div>
          )}
          {unknown && (
            <div
              role="alert"
              className="flex items-start gap-2 border-b border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger sm:px-6"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                An operation has an unknown outcome. Further execution is paused
                until Revit reports its result.
              </span>
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 border-b border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger sm:px-6"
            >
              <CircleAlert className="size-4 shrink-0" />
              <span className="flex-1">{error}</span>
              <button
                type="button"
                aria-label="Dismiss error"
                className="rounded-sm p-1 hover:bg-danger/10"
                onClick={() => setError("")}
              >
                <X className="size-4" />
              </button>
            </div>
          )}

          {tab === "chat" ? (
            <>
              <div
                ref={transcript}
                role="log"
                aria-label="Conversation"
                className="min-h-0 flex-1 overflow-y-auto"
              >
                {!state?.messages.length ? (
                  <Welcome
                    connected={ready}
                    onSuggestion={(text) => setPrompt(text)}
                  />
                ) : (
                  <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4 sm:px-6">
                    {state.messages.map((message) =>
                      message.role === "user" ? (
                        <div
                          key={message.id}
                          className="flex justify-end animate-slide-up"
                          aria-label="Your message"
                        >
                          <div className="min-w-0 max-w-[min(85%,560px)] whitespace-pre-wrap break-words rounded-md bg-surface-muted px-3.5 py-2 text-[14px] leading-6 text-ink">
                            {message.text}
                          </div>
                        </div>
                      ) : (
                        <article
                          key={message.id}
                          className={cn(
                            "animate-slide-up text-[14px] leading-7",
                            message.role === "system" &&
                              "border-l-2 border-warn/40 pl-3 text-warn",
                          )}
                        >
                          <p className="mb-1 text-[11px] font-medium text-muted">
                            {message.role === "assistant"
                              ? "Revcode"
                              : "System"}
                          </p>
                          <div className="whitespace-pre-wrap break-words">
                            {message.text || "…"}
                          </div>
                        </article>
                      ),
                    )}
                  </div>
                )}
              </div>
              <Composer
                draft={prompt}
                onDraftChange={setPrompt}
                disabled={!canExecute || !state?.settings.configured}
                submitDisabled={!prompt.trim()}
                streaming={busy}
                abortDisabled={pending}
                onSubmit={() => void submit("chat")}
                onAbort={() => void cancel()}
                controls={modelControls}
                hint={
                  !state?.settings.configured ? (
                    <p className="mx-auto mb-2 max-w-[760px] text-center text-[11px] text-muted">
                      <button
                        type="button"
                        className="text-accent underline underline-offset-2"
                        onClick={() => setSettingsOpen(true)}
                      >
                        Connect a provider
                      </button>{" "}
                      to use the assistant, or{" "}
                      <button
                        type="button"
                        className="text-accent underline underline-offset-2"
                        onClick={() => setTab("console")}
                      >
                        test the C# console
                      </button>{" "}
                      without credentials.
                    </p>
                  ) : undefined
                }
              />
            </>
          ) : (
            <ConsolePanel
              code={code}
              mode={mode}
              examples={examples}
              busy={busy}
              pending={pending}
              canExecute={canExecute}
              readOnly={doc?.isReadOnly}
              onCodeChange={setCode}
              onModeChange={setMode}
              onExample={(example) => {
                setCode(example.code);
                setMode(example.mode);
              }}
              onRun={() => void submit("execute")}
              onStop={() => void cancel()}
            />
          )}

          <OperationsPanel operations={operations} />
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
    </TooltipProvider>
  );
}
