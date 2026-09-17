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
import { ThreadList } from "./components/thread-list";
import {
  ExecutionHistory,
  type Operation,
  type RunSummary,
  type RunDetail,
} from "./components/execution-history";
import { ModelControls } from "./components/model-picker";
import { ProviderDialog } from "./provider-dialog";
import type {
  AuthState,
  Context,
  Message,
  ProviderSummary,
  Settings,
  ThreadSummary,
} from "../../src/host/types";
import { SkillsDialog } from "./components/skills-dialog";
import type { SkillSummary } from "../../src/host/skills";
import { useConsoleDraft } from "./lib/use-console-draft";
import { Sidebar } from "./components/sidebar";
import {
  ToastRegion,
  type ToastLevel,
  type ToastNotice,
} from "./components/toasts";
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
import { Loader2, TriangleAlert } from "lucide-react";
import { DesktopPanel } from "./components/desktop-panel";
import type { DesktopState } from "../../src/host/desktop-types";
type HostState = {
  threads?: ThreadSummary[];
  selectedThreadId?: string;
  activeThreadId?: string;
  hasOlderMessages?: boolean;
  instanceId: string;
  connected: boolean;
  busy: boolean;
  chatBusy?: boolean;
  runs?: RunSummary[];
  context: Context | null;
  messages: Message[];
  operations: Operation[];
  settings: Settings;
  providers: ProviderSummary[];
  auth?: AuthState;
  desktop?: DesktopState;
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
async function loadHistoryImage(artifact: string) {
  const response = await fetch(
    `/api/history/image/${encodeURIComponent(artifact)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok)
    throw new Error("Recorded image is unavailable or expired.");
  return response.blob();
}

async function loadDesktopImage(artifact: string, signal: AbortSignal) {
  const response = await fetch(
    `/api/desktop/image/${encodeURIComponent(artifact)}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
  if (!response.ok) throw new Error("Screenshot unavailable.");
  return response.blob();
}

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
      <Badge
        variant="neutral"
        dot
        pulse
        className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal"
      >
        <span className="text-ink">Offline</span>
      </Badge>
    );
  if (!revitConnected)
    return (
      <Badge
        variant="warn"
        dot
        pulse
        className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal"
      >
        <span className="text-ink">Connecting</span>
      </Badge>
    );
  return (
    <Badge
      variant="accent"
      dot={!busy}
      className="h-7 gap-2 border-0 bg-transparent p-0 text-xs font-normal"
    >
      {busy && (
        <Loader2
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin"
        />
      )}
      <span className="text-ink">{busy ? "Working" : "Ready"}</span>
    </Badge>
  );
}

function App() {
  const [selectedThreadId, setSelectedThreadId] = useState(() => {
    try {
      return sessionStorage.getItem("revcode.thread") ?? "";
    } catch {
      return "";
    }
  });
  const selectedThreadRef = useRef(selectedThreadId);
  const threadDrafts = useRef(
    new Map<
      string,
      {
        prompt: string;
        skills: SkillSummary[];
        authoring?: { sourceRunId?: string; destinationSkillId?: string };
      }
    >(),
  );
  const [olderAvailable, setOlderAvailable] = useState<boolean>();
  const [activeToken, setActiveToken] = useState(token);
  const [state, setState] = useState<HostState | null>(null);
  const [hostOnline, setHostOnline] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [previewSkillId, setPreviewSkillId] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<SkillSummary[]>([]);
  const [authoringDraft, setAuthoringDraft] = useState<{
    sourceRunId?: string;
    destinationSkillId?: string;
  }>();
  const [selectedRun, setSelectedRun] = useState("");
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [jumpMessageId, setJumpMessageId] = useState("");
  const [steps, setSteps] = useState([
    { name: "Step 1", code: "return null;" },
  ]);
  const [verify, setVerify] = useState("");
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
  const chatRequest = useRef<{ key: string; id: string } | undefined>(
    undefined,
  );
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
        const next = await api<HostState>(
          `/api/state?threadId=${encodeURIComponent(selectedThreadId)}`,
          undefined,
          controller.signal,
        );
        if (!disposed) {
          setState(next);
          if (
            next.selectedThreadId &&
            next.selectedThreadId !== selectedThreadId
          ) {
            selectedThreadRef.current = next.selectedThreadId;
            setSelectedThreadId(next.selectedThreadId);
          }
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
  }, [activeToken, selectedThreadId]);
  useEffect(() => {
    try {
      sessionStorage.setItem("revcode.thread", selectedThreadId);
    } catch {
      /* Selection works without storage. */
    }
  }, [selectedThreadId]);
  const draftStorage = useConsoleDraft({
    api,
    instanceId: state?.instanceId,
    online: hostOnline,
    draft: {
      version: 1,
      code,
      mode,
      steps,
      verify,
      documentToken: documentToken || state?.context?.document?.token || "",
      sessionId: state?.context?.instanceId ?? null,
    },
    restore(saved) {
      setCode(saved.code);
      setMode(saved.mode);
      setSteps(saved.steps);
      setVerify(saved.verify);
      const sameSession =
        !!saved.sessionId && saved.sessionId === state?.context?.instanceId;
      const documents =
        state?.context?.documents ??
        (state?.context?.document ? [state.context.document] : []);
      setDocumentToken(
        sameSession &&
          documents.some((document) => document.token === saved.documentToken)
          ? saved.documentToken
          : "__reselect__",
      );
    },
  });
  const doc = state?.context?.document ?? null;
  const openDocuments = state?.context?.documents ?? (doc ? [doc] : []);
  const targetDocument = documentToken
    ? openDocuments.find((d) => d.token === documentToken)
    : doc;
  const ready = hostOnline && !!state?.connected;
  const busy = pending || !!state?.busy;
  const unknown = state?.operations.some(
    (operation) => operation.status === "unknown",
  );
  const canExecute = ready && !busy && !unknown;
  const authoringRequest =
    !!authoringDraft ||
    /\b(?:create|make|update|revise|edit)\s+(?:(?:a|an|the|this|that|existing|reusable)\s+){0,3}skill\b/i.test(
      prompt,
    );
  const selectedThread = state?.threads?.find(
    (thread) => thread.id === selectedThreadId,
  );
  const threadReady =
    !state?.selectedThreadId || state.selectedThreadId === selectedThreadId;
  const canChat =
    threadReady &&
    !selectedThread?.archivedAt &&
    (authoringRequest
      ? hostOnline && !pending && !(state?.chatBusy ?? state?.busy)
      : canExecute);
  const canRunSnippet =
    canExecute &&
    (!documentToken || !!targetDocument) &&
    ((mode !== "modify" && mode !== "batch") ||
      (!!targetDocument && !targetDocument.isReadOnly));
  const operations = [...(state?.operations ?? [])].reverse();
  const providerName = providerLabel(
    state?.settings.provider,
    state?.providers ?? [],
  );
  const connectionDetail = !hostOnline ? connectionError : "";
  function openSettings() {
    setMobileOpen(false);
    setSettingsOpen(true);
  }
  async function refreshState() {
    const id = selectedThreadRef.current;
    const next = await api<HostState>(
      `/api/state?threadId=${encodeURIComponent(id)}`,
    );
    if (selectedThreadRef.current === id) setState(next);
  }
  function selectThread(id: string) {
    if (pending || id === selectedThreadId) return;
    threadDrafts.current.set(selectedThreadId, {
      prompt,
      skills: selectedSkills,
      authoring: authoringDraft,
    });
    const draft = threadDrafts.current.get(id);
    setPrompt(draft?.prompt ?? "");
    setSelectedSkills(draft?.skills ?? []);
    setAuthoringDraft(draft?.authoring);
    selectedThreadRef.current = id;
    setSelectedThreadId(id);
    setOlderMessages([]);
    setOlderAvailable(undefined);
    setSelectedRun("");
    setJumpMessageId("");
    setMobileOpen(false);
  }
  async function createThread() {
    if (pending) return;
    setPending(true);
    try {
      const thread = await api<ThreadSummary>("/api/threads", {
        requestId: crypto.randomUUID(),
      });
      selectThread(thread.id);
    } catch (reason) {
      toast(String(reason));
    } finally {
      setPending(false);
    }
  }
  async function archiveThread(thread: ThreadSummary) {
    try {
      await api("/api/threads/archive", {
        threadId: thread.id,
        archived: !thread.archivedAt,
      });
      await refreshState();
      toast(
        thread.archivedAt
          ? "Thread restored."
          : "Thread archived. Restore it from Archived to continue.",
        "info",
      );
    } catch (reason) {
      toast(String(reason));
    }
  }
  async function loadOlderMessages() {
    const id = selectedThreadId;
    const before = olderMessages[0]?.id ?? state?.messages[0]?.id;
    try {
      const page = await api<{
        messages: Message[];
        hasOlderMessages: boolean;
      }>(
        `/api/threads/messages?threadId=${encodeURIComponent(id)}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
      );
      if (selectedThreadRef.current !== id) return;
      setOlderMessages((current) => [
        ...page.messages.filter(
          (m) => !current.some((existing) => existing.id === m.id),
        ),
        ...current,
      ]);
      setOlderAvailable(page.hasOlderMessages);
    } catch (reason) {
      toast(String(reason));
    }
  }
  async function submitChat() {
    if (submitting.current || !canChat || !state?.settings.configured) return;
    submitting.current = true;
    setPending(true);
    try {
      const payload = {
        threadId: selectedThreadId || undefined,
        text: prompt.trim(),
        mode: authoringDraft ? "authoring" : "execution",
        selectedSkillIds: selectedSkills.map((skill) => skill.id),
        sourceRunIds: authoringDraft?.sourceRunId
          ? [authoringDraft.sourceRunId]
          : [],
        ...(authoringDraft?.destinationSkillId
          ? { destinationSkillId: authoringDraft.destinationSkillId }
          : {}),
      };
      const key = JSON.stringify(payload);
      if (chatRequest.current?.key !== key)
        chatRequest.current = { key, id: crypto.randomUUID() };
      await api("/api/chat", { requestId: chatRequest.current.id, ...payload });
      chatRequest.current = undefined;
      setPrompt("");
      setAuthoringDraft(undefined);
      setSelectedSkills([]);
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
        ...(mode === "batch"
          ? {
              mode,
              steps,
              ...(verify.trim() ? { verify: { code: verify } } : {}),
              documentToken: targetDocument?.token,
            }
          : { code, mode, ...(documentToken ? { documentToken } : {}) }),
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
  function author(sourceRunId?: string, skill?: SkillSummary) {
    setAuthoringDraft({
      sourceRunId,
      destinationSkillId: skill?.source === "user" ? skill.id : undefined,
    });
    setPrompt(
      skill
        ? `${skill.source === "user" ? "Update" : "Create a user copy of"} the skill "${skill.name}" with what we learned${sourceRunId ? " from the recent run" : ""}. Preserve unrelated instructions.`
        : "Create a reusable skill from the recent run. Distinguish verified outcomes from incomplete work and include verification and recovery guidance.",
    );
    setSkillsOpen(false);
    composer.current?.focus();
  }
  async function authorRecent(skill?: SkillSummary) {
    try {
      if (skill && authoringDraft?.sourceRunId) {
        author(authoringDraft.sourceRunId, skill);
        return;
      }
      let recent: RunSummary | undefined;
      let cursor: string | undefined;
      do {
        const page = await api<{ runs: RunSummary[]; nextCursor?: string }>(
          `/api/runs?threadId=${encodeURIComponent(selectedThreadId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        recent = page.runs.find((run) => run.intent !== "authoring");
        cursor = page.nextCursor;
      } while (!recent && cursor);
      if (selectedThreadRef.current !== selectedThreadId) return;
      if (!recent && !skill) {
        toast(
          "No usable recorded work yet. Describe the workflow you want to capture.",
          "info",
        );
        return;
      }
      author(recent?.id, skill);
      if (!state?.settings.configured)
        toast("Connect a provider to create or update skills.", "info");
    } catch (reason) {
      toast(String(reason));
    }
  }
  function jumpToRun(detail: RunDetail) {
    if ((detail.run.threadId ?? "legacy") !== selectedThreadRef.current && selectedThreadRef.current) return;
    const message = detail.messages.find(
      (item) => item.id === detail.run.userMessageId,
    );
    if (!message) {
      toast("The associated message is unavailable or expired.", "info");
      return;
    }
    setOlderMessages((current) => [
      ...current.filter(
        (item) => !detail.messages.some((next) => next.id === item.id),
      ),
      ...detail.messages,
    ]);
    setJumpMessageId(message.id);
  }
  async function cancel() {
    try {
      await api("/api/cancel", {});
    } catch (reason) {
      toast(
        reason instanceof Error
          ? reason.message
          : "Could not request cancellation.",
      );
    }
  }
  async function selectModel(provider: string, model: string) {
    try {
      await api("/api/settings", { provider, model });
      await refreshState();
    } catch (reason) {
      toast(
        reason instanceof Error ? reason.message : "Could not switch models.",
      );
    }
  }
  if (!token)
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-canvas px-6 text-center text-ink">
        <img src={mark} alt="" className="size-12 rounded-[10px] shadow-card" />
        <h1 className="text-lg font-semibold tracking-tight">
          Open Revcode from Revit
        </h1>
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
        <a
          className="skip-link"
          href="#prompt"
          onClick={(event) => {
            event.preventDefault();
            composer.current?.focus();
          }}
        >
          Skip to message
        </a>
        <Sidebar
          threads={
            <ThreadList
              threads={state?.threads ?? []}
              selectedId={selectedThreadId}
              activeId={state?.activeThreadId}
              online={hostOnline && !pending}
              onSelect={selectThread}
              onCreate={() => void createThread()}
              onArchive={(thread) => void archiveThread(thread)}
            />
          }
          desktop={state?.desktop}
          vision={
            !!state?.providers
              .find((provider) => provider.id === state.settings.provider)
              ?.models.find((model) => model.id === state.settings.model)
              ?.supportsImages
          }
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
          onOpenSkills={() => {
            setMobileOpen(false);
            setSkillsOpen(true);
          }}
          onOpenConsole={() => {
            setMobileOpen(false);
            setConsoleOpen(true);
          }}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
            <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight text-ink-soft">
              {selectedThread?.title ?? "Build with your model."}
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
          {state?.activeThreadId &&
            state.activeThreadId !== selectedThreadId && (
              <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-2 text-xs text-ink-soft">
                <span>
                  Another thread is working. You can browse history while it
                  finishes.
                </span>
                <button
                  className="text-accent"
                  onClick={() => selectThread(state.activeThreadId!)}
                >
                  Jump back
                </button>
              </div>
            )}
          {selectedThread?.archivedAt && (
            <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-2 text-xs text-ink-soft">
              <span>This thread is archived.</span>
              <button
                className="text-accent"
                onClick={() => void archiveThread(selectedThread)}
              >
                Unarchive to continue
              </button>
            </div>
          )}
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
          <DesktopPanel
            loadImage={loadDesktopImage}
            state={state?.desktop}
            online={hostOnline}
            stop={async () => {
              await api("/api/desktop/stop", {});
            }}
          />
          <Conversation
            key={selectedThreadId}
            messages={[
              ...olderMessages.filter(
                (message) =>
                  !state?.messages.some((current) => current.id === message.id),
              ),
              ...(threadReady ? (state?.messages ?? []) : []),
            ]}
            onViewTools={setSelectedRun}
            jumpMessageId={jumpMessageId}
            busy={
              busy &&
              (!state?.activeThreadId ||
                state.activeThreadId === selectedThreadId)
            }
            connected={hostOnline}
            configured={!!state?.settings.configured}
            onSuggestion={(text) => {
              setPrompt(text);
              composer.current?.focus();
            }}
          />
          {threadReady && (olderAvailable ?? state?.hasOlderMessages) && (
            <button
              className="shrink-0 py-2 text-xs text-accent"
              onClick={() => void loadOlderMessages()}
            >
              Load earlier messages
            </button>
          )}
          <Composer
            ref={composer}
            draft={prompt}
            onDraftChange={setPrompt}
            onSubmit={() => void submitChat()}
            disabled={
              !hostOnline || !!selectedThread?.archivedAt || !threadReady
            }
            submitDisabled={!canChat || !state?.settings.configured}
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
            canAbort={
              busy &&
              (!state?.activeThreadId ||
                state.activeThreadId === selectedThreadId)
            }
            abortDisabled={pending || !hostOnline}
            onAbort={() => void cancel()}
            controls={
              <>
                <ModelControls
                  connected={hostOnline && !!state}
                  providers={state?.providers ?? []}
                  selected={state?.settings ?? { provider: "", model: "" }}
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
        <ExecutionHistory
          key={selectedThreadId}
          threadId={selectedThreadId || undefined}
          loadImage={loadHistoryImage}
          onOpenSkill={(id) => {
            setPreviewSkillId(id);
            setSkillsOpen(true);
          }}
          operations={operations}
          api={api}
          online={hostOnline}
          activity={JSON.stringify(state?.runs ?? [])}
          selectedRun={selectedRun}
          onSelectRun={setSelectedRun}
          onJump={jumpToRun}
        />
        <SkillsDialog
          initialId={previewSkillId}
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          api={api}
          online={hostOnline}
          busy={!!state?.chatBusy}
          selected={selectedSkills.map((skill) => skill.id)}
          onSelect={(skill) =>
            setSelectedSkills((current) =>
              current.some((item) => item.id === skill.id)
                ? current
                : [...current, skill],
            )
          }
          onAuthor={(skill) => void authorRecent(skill)}
        />
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
                <DialogTitle id="console-title">
                  Run a C# method body
                </DialogTitle>
                <DialogDescription>
                  The same executor the assistant uses. No model or API key
                  required. Access the target document through{" "}
                  <code className="rounded-[3px] bg-surface-muted px-1 py-0.5 font-mono text-[0.9em]">
                    ctx.Doc
                  </code>
                  .
                </DialogDescription>
              </DialogHeader>
              {draftStorage.status.includes("could not") && (
                <button
                  className="text-xs text-accent"
                  onClick={draftStorage.retrySave}
                >
                  Retry draft storage
                </button>
              )}
              <ConsolePanel
                draftStatus={draftStorage.status}
                onClearDraft={() => {
                  setCode("");
                  setMode("query");
                  setSteps([{ name: "Step 1", code: "" }]);
                  setVerify("");
                }}
                steps={steps}
                onStepsChange={setSteps}
                verify={verify}
                onVerifyChange={setVerify}
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
