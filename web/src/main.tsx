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
import type { AuthState, Context, Message, ProviderSummary, Settings } from "../../src/host/types";
import { Sidebar } from "./components/sidebar";
import { ToastRegion, type ToastLevel, type ToastNotice } from "./components/toasts";
import { Badge } from "./components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { TooltipProvider } from "./components/ui/tooltip";
import { providerLabel } from "./lib/utils";
import mark from "./assets/revcode-mark.svg";
import { TriangleAlert } from "lucide-react";

type HostState = {
  instanceId: string;
  connected: boolean;
  busy: boolean;
  context: Context | null;
  messages: Message[];
  operations: Operation[];
  settings: Settings;
  providers: ProviderSummary[];
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
  const [prompt, setPrompt] = useState("");
  const [code, setCode] = useState(examples[0].code);
  const [mode, setMode] = useState<Mode>("query");
  const [documentToken, setDocumentToken] = useState("");
  const [pending, setPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
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

  const doc = state?.context?.document ?? null;
  const openDocuments = state?.context?.documents ?? (doc ? [doc] : []);
  const targetDocument = documentToken ? openDocuments.find(d => d.token === documentToken) : doc;
  const ready = hostOnline && !!state?.connected;
  const busy = pending || !!state?.busy;
  const unknown = state?.operations.some(
    (operation) => operation.status === "unknown",
  );
  const canExecute = ready && !busy && !unknown;
  const canRunSnippet = canExecute && (!documentToken || !!targetDocument)
    && (mode !== "modify" || (!!targetDocument && !targetDocument.isReadOnly));
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
    if (submitting.current || !canRunSnippet) return;
    submitting.current = true;
    setPending(true);
    try {
      await api("/api/execute", {
        requestId: crypto.randomUUID(),
        code,
        mode,
        ...(documentToken ? { documentToken } : {}),
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
        <a className="skip-link" href="#prompt" onClick={(event) => {
          event.preventDefault();
          composer.current?.focus();
        }}>
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
          onOpenConsole={() => {
            setMobileOpen(false);
            setConsoleOpen(true);
          }}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
            <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight text-ink-soft">
              Build with your model.
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
                  <button type="button" onClick={() => setConsoleOpen(true)}>
                    test the C# console
                  </button>{" "}
                  without credentials.
                </>
              ) : undefined
            }
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
        </main>
        <ExecutionHistory operations={operations} />

        {consoleOpen && (
          <Dialog
            open
            onOpenChange={(next) => {
              if (!next) setConsoleOpen(false);
            }}
          >
            <DialogContent
              aria-labelledby="console-title"
              className="w-[min(680px,calc(100%-2rem))] gap-3"
            >
              <DialogHeader>
                <DialogTitle id="console-title">Run a C# method body</DialogTitle>
                <DialogDescription>
                  The same executor the assistant uses. No model or API key
                  required. Access the target document through{" "}
                  <code className="rounded-[3px] bg-surface-muted px-1 py-0.5 font-mono text-[0.9em]">
                    ctx.Doc
                  </code>
                  .
                </DialogDescription>
              </DialogHeader>
              <ConsolePanel
                code={code}
                onCodeChange={setCode}
                mode={mode}
                onModeChange={setMode}
                documentToken={documentToken}
                onDocumentTokenChange={setDocumentToken}
                documents={openDocuments}
                activeDocumentTitle={doc?.title}
                busy={busy}
                pending={pending}
                canRun={canRunSnippet}
                onRun={() => void executeSnippet()}
                onCancel={() => void cancel()}
                docReadOnly={!!targetDocument?.isReadOnly}
              />
            </DialogContent>
          </Dialog>
        )}

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
