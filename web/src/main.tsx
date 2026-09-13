import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import { ConnectionBanner } from "./components/connection-banner";
import { Composer, type ComposerHandle } from "./components/composer";
import {
  ConsolePanel,
  DocumentTarget,
  examples,
  type Mode,
} from "./components/console-panel";
import { Conversation } from "./components/conversation";
import { ExecutionHistory, type Operation } from "./components/execution-history";
import { ModelControls } from "./components/model-picker";
import { ProviderDialog } from "./provider-dialog";
import type { AuthState, Provider } from "./components/provider-types";
import { Sidebar } from "./components/sidebar";
import { ToastRegion, type ToastLevel, type ToastNotice } from "./components/toasts";
import { Badge } from "./components/ui/badge";
import { TooltipProvider } from "./components/ui/tooltip";
import { providerLabel } from "./lib/utils";
import mark from "./assets/revcode-mark.svg";
import { TriangleAlert } from "lucide-react";

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

const SIDEBAR_KEY = "revcode.sidebar.collapsed";

function readCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function StatusPill({
  hostOnline,
  revitConnected,
  busy,
}: {
  hostOnline: boolean;
  revitConnected: boolean;
  busy: boolean;
}) {
  if (!hostOnline)
    return (
      <Badge variant="neutral" dot pulse className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal">
        <span className="text-ink">Offline</span>
      </Badge>
    );
  if (!revitConnected)
    return (
      <Badge variant="warn" dot pulse className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal">
        <span className="text-ink">Connecting</span>
      </Badge>
    );
  return (
    <Badge variant="accent" dot pulse={busy} className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal">
      <span className="text-ink">{busy ? "Working" : "Ready"}</span>
    </Badge>
  );
}

function App() {
  const [activeToken, setActiveToken] = useState(token);
  const [state, setState] = useState<HostState | null>(null);
  const [hostOnline, setHostOnline] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [tab, setTab] = useState<"chat" | "console">("chat");
  const [prompt, setPrompt] = useState("");
  const [code, setCode] = useState(examples[0].code);
  const [mode, setMode] = useState<Mode>("query");
  const [pending, setPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notices, setNotices] = useState<ToastNotice[]>([]);
  const toastId = useRef(0);
  const composer = useRef<ComposerHandle>(null);
  const submitting = useRef(false);

  const toast = useCallback((message: string, level: ToastLevel = "error") => {
    const id = ++toastId.current;
    setNotices((current) => [
      ...current.slice(-3),
      { id, level, message, timeout: level === "error" ? 8000 : 5000 },
    ]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      // Storage may be unavailable; the preference is only a convenience.
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
        const next = await api<HostState>("/api/state", undefined, controller.signal);
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

  useEffect(() => {
    document.title = "Revcode";
  }, []);

  const doc = state?.context?.document ?? null;
  const ready = hostOnline && !!state?.connected && !!doc;
  const busy = pending || !!state?.busy;
  const unknown = state?.operations.some(
    (operation) => operation.status === "unknown",
  );
  const canExecute = ready && !busy && !unknown;
  const operations = [...(state?.operations ?? [])].reverse();
  const providerName = providerLabel(state?.settings.provider, state?.providers ?? []);
  const connectionDetail = !hostOnline ? connectionError : "";

  function openSettings() {
    setMobileOpen(false);
    setSettingsOpen(true);
  }

  async function refreshState() {
    setState(await api<HostState>("/api/state"));
  }

  async function submitChat() {
    if (submitting.current || !canExecute || !state?.settings.configured) return;
    submitting.current = true;
    setPending(true);
    try {
      await api("/api/chat", {
        requestId: crypto.randomUUID(),
        text: prompt.trim(),
      });
      setPrompt("");
      composer.current?.focus();
      await refreshState();
    } catch (reason) {
      toast(
        reason instanceof Error
          ? reason.message
          : "Request failed. Check operation history before submitting again.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  async function executeSnippet() {
    if (submitting.current || !canExecute) return;
    submitting.current = true;
    setPending(true);
    try {
      await api("/api/execute", {
        requestId: crypto.randomUUID(),
        code,
        mode,
        transactionName: "Revcode: C# console",
      });
      await refreshState();
    } catch (reason) {
      toast(
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
    try {
      await api("/api/cancel", {});
    } catch (reason) {
      toast(
        reason instanceof Error ? reason.message : "Could not request cancellation.",
      );
    }
  }

  async function selectModel(provider: string, model: string) {
    try {
      await api("/api/settings", { provider, model });
      await refreshState();
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Could not switch models.");
    }
  }

  if (!token)
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ink">
        <img src={mark} alt="" className="size-12 rounded-[10px] shadow-card" />
        <h1 className="text-lg font-semibold tracking-tight">Open Revcode from Revit</h1>
        <p className="max-w-sm text-[13px] leading-relaxed text-ink-soft">
          Click the Revcode ribbon button to connect this browser to your Revit
          session.
        </p>
        <p className="text-xs text-muted">
          The ribbon supplies a private connection token for this tab.
        </p>
      </main>
    );

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink lg:flex-row">
        <a className="skip-link" href="#prompt">
          Skip to message
        </a>
        <Sidebar
          hostOnline={hostOnline}
          revitConnected={!!state?.connected}
          revitVersion={state?.context?.revitVersion}
          revitBuild={state?.context?.revitBuild}
          document={doc}
          providerConfigured={!!state?.settings.configured}
          providerName={providerName}
          providerModel={state?.settings.model ?? ""}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          mobileOpen={mobileOpen}
          onMobileOpenChange={setMobileOpen}
          onManageProvider={openSettings}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
            <nav
              aria-label="Workspace"
              className="flex shrink-0 items-center rounded-sm bg-surface-muted p-0.5"
            >
              <button
                type="button"
                aria-pressed={tab === "chat"}
                onClick={() => setTab("chat")}
                className={
                  tab === "chat"
                    ? "h-6 rounded-[3px] bg-surface px-2 text-xs font-medium text-ink shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    : "h-6 rounded-[3px] px-2 text-xs font-medium text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                }
              >
                Assistant
              </button>
              <button
                type="button"
                aria-pressed={tab === "console"}
                onClick={() => setTab("console")}
                className={
                  tab === "console"
                    ? "h-6 rounded-[3px] bg-surface px-2 text-xs font-medium text-ink shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    : "h-6 rounded-[3px] px-2 text-xs font-medium text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                }
              >
                C# console
              </button>
            </nav>
            <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight text-ink-soft">
              {tab === "chat" ? "Build with your model." : "A direct line to Revit."}
            </h1>
            <StatusPill
              hostOnline={hostOnline}
              revitConnected={!!state?.connected}
              busy={busy}
            />
          </header>
          <ConnectionBanner
            hostOnline={hostOnline}
            revitConnected={!!state?.connected}
            detail={connectionDetail}
          />
          {unknown && (
            <div
              role="alert"
              className="flex shrink-0 items-start gap-2 border-b border-warn/30 bg-warn-soft px-4 py-1.5 text-xs text-warn sm:px-6"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                An operation has an unknown outcome. Further execution is paused
                until Revit reports its result. Inspect the model before taking
                further action.
              </span>
            </div>
          )}
          {tab === "chat" ? (
            <>
              <Conversation
                messages={state?.messages ?? []}
                busy={busy}
                connected={hostOnline}
                configured={!!state?.settings.configured}
                onSuggestion={(text) => {
                  setPrompt(text);
                  composer.current?.focus();
                }}
              />
              <Composer
                ref={composer}
                draft={prompt}
                onDraftChange={setPrompt}
                onSubmit={() => void submitChat()}
                disabled={!hostOnline}
                submitDisabled={!canExecute || !state?.settings.configured}
                alert={
                  hostOnline && state && !state.settings.configured ? (
                    <>
                      <button type="button" onClick={openSettings}>
                        Connect a provider
                      </button>{" "}
                      to use the assistant, or{" "}
                      <button type="button" onClick={() => setTab("console")}>
                        test the C# console
                      </button>{" "}
                      without credentials.
                    </>
                  ) : undefined
                }
                streaming={busy}
                canAbort={busy}
                abortDisabled={pending || !hostOnline}
                onAbort={() => void cancel()}
                controls={
                  <>
                    <ModelControls
                      connected={hostOnline && !!state}
                      providers={state?.providers ?? []}
                      selected={
                        state?.settings ?? { provider: "", model: "" }
                      }
                      onSelectModel={(provider, model) =>
                        void selectModel(provider, model)
                      }
                      onManageProvider={openSettings}
                    />
                    <DocumentTarget label={doc?.title ?? "No document"} />
                  </>
                }
              />
            </>
          ) : (
            <ConsolePanel
              code={code}
              onCodeChange={setCode}
              mode={mode}
              onModeChange={setMode}
              busy={busy}
              pending={pending}
              canRun={canExecute}
              onRun={() => void executeSnippet()}
              onCancel={() => void cancel()}
              docReadOnly={!!doc?.isReadOnly}
            />
          )}
          <ExecutionHistory operations={operations} />
        </main>

        {settingsOpen && state && (
          <ProviderDialog
            providers={state.providers}
            auth={state.auth}
            selected={state.settings}
            api={api}
            refresh={refreshState}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        <ToastRegion notices={notices} onDismiss={dismissToast} />
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
