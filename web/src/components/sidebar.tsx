import {
  KeyRound,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { cn, providerLabel } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type Document = {
  title: string;
  isFamily: boolean;
  isReadOnly: boolean;
  activeView: string;
  selection: string[];
};

type SidebarProps = {
  tab: "chat" | "console";
  onTabChange(tab: "chat" | "console"): void;
  connected: boolean;
  hostOnline: boolean;
  revitConnected: boolean;
  connectionDetail: string;
  revitVersion?: string;
  revitBuild?: string;
  document?: Document | null;
  provider?: string;
  model?: string;
  providers: Array<{ id: string; name?: string }>;
  providerConfigured: boolean;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  mobileOpen: boolean;
  onMobileOpenChange(open: boolean): void;
  onManageProvider(): void;
  onReconnect(): void;
};

function toneClass(tone: "ok" | "warn" | "danger" | "muted") {
  return {
    ok: "bg-accent",
    warn: "bg-warn animate-pulse",
    danger: "bg-danger",
    muted: "bg-line-strong animate-pulse",
  }[tone];
}

export function Sidebar({
  tab,
  onTabChange,
  connected,
  hostOnline,
  revitConnected,
  connectionDetail,
  revitVersion,
  revitBuild,
  document,
  provider,
  model,
  providers,
  providerConfigured,
  collapsed,
  onCollapsedChange,
  mobileOpen,
  onMobileOpenChange,
  onManageProvider,
  onReconnect,
}: SidebarProps) {
  const container = useRef<HTMLElement>(null);
  const connectionTone: "ok" | "warn" | "danger" | "muted" = !hostOnline
    ? "muted"
    : revitConnected
      ? "ok"
      : "warn";
  const connectionLabel = !hostOnline
    ? "Connecting to host"
    : revitConnected
      ? "Revit connected"
      : "Waiting for Revit";

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMobileOpenChange(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (container.current && !container.current.contains(event.target as Node))
        onMobileOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [mobileOpen, onMobileOpenChange]);

  const nav = (
    <nav aria-label="Workspace" className="grid flex-1 gap-1 lg:px-3">
      <Button
        variant={tab === "chat" ? "secondary" : "ghost"}
        size="sm"
        className="w-full justify-start"
        onClick={() => {
          onTabChange("chat");
          onMobileOpenChange(false);
        }}
      >
        <MessageSquare className="size-3.5" />
        Assistant
      </Button>
      <Button
        variant={tab === "console" ? "secondary" : "ghost"}
        size="sm"
        className="w-full justify-start"
        aria-label="C# console"
        onClick={() => {
          onTabChange("console");
          onMobileOpenChange(false);
        }}
      >
        <Terminal className="size-3.5" />
        C# console
      </Button>
    </nav>
  );

  const documentCard = (
    <div className="mx-3 rounded-md border border-line bg-surface px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
        Active document
      </p>
      <p className="mt-1 truncate text-xs font-medium">
        {document?.title || "No document open"}
      </p>
      <p className="mt-0.5 text-[11px] leading-4 text-muted">
        {document
          ? `${document.isFamily ? "Family" : "Project"}${document.isReadOnly ? " · Read only" : ""}`
          : "Open a project or family in Revit."}
      </p>
      {document && (
        <>
          <div className="my-2 h-px bg-line" />
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted">View</p>
          <p className="mt-0.5 truncate text-[11px] text-ink-soft">
            {document.activeView || "—"}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            {document.selection.length} selected elements
          </p>
        </>
      )}
    </div>
  );

  const connectionStatus = (
    <div className="flex items-start gap-2 px-3 py-1.5">
      <span
        aria-hidden="true"
        className={cn("mt-[5px] size-1.5 shrink-0 rounded-full", toneClass(connectionTone))}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{connectionLabel}</p>
        {revitVersion && (
          <p className="mt-0.5 hidden text-[11px] leading-4 text-muted lg:block">
            Revit {revitVersion}
            {revitBuild ? ` · Build ${revitBuild}` : ""}
          </p>
        )}
      </div>
      {!hostOnline && (
        <Button size="xs" variant="secondary" onClick={onReconnect}>
          <RefreshCw className="size-3" />
          Retry
        </Button>
      )}
    </div>
  );

  const panels = (
    <>
      {documentCard}
      <div className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
            Provider
          </span>
          <Badge variant={providerConfigured ? "accent" : "warn"} dot>
            {providerConfigured ? "Signed in" : "Not set up"}
          </Badge>
        </div>
        <button
          type="button"
          className="provider-button mt-1.5 flex w-full items-center justify-between gap-2 rounded-sm px-1 py-1 text-left text-xs font-medium transition-colors hover:bg-ink/[.04]"
          onClick={onManageProvider}
        >
          <span className="min-w-0 truncate">
            {providerConfigured
              ? providerLabel(provider, providers)
              : "Set up a provider"}
            {providerConfigured && model && (
              <span className="mt-0.5 block truncate text-[10px] font-normal text-muted">
                {model}
              </span>
            )}
          </span>
          <KeyRound className="size-3.5 shrink-0 text-muted" />
        </button>
      </div>
    </>
  );

  return (
    <aside
      ref={container}
      aria-label="Revcode controls"
      className={cn(
        "relative z-20 flex shrink-0 flex-col border-b border-line bg-panel lg:h-full lg:border-b-0 lg:border-r lg:transition-[width] lg:duration-200",
        collapsed ? "lg:w-12" : "lg:w-[248px]",
      )}
    >
      <div className="flex flex-col gap-2 px-3 py-2 lg:hidden">
        <div className="flex items-center gap-2">
          <span className="flex flex-1 items-center gap-2 text-[13px] font-semibold tracking-tight">
            <span>
              <span className="text-accent-hover">Rev</span>code
            </span>
          </span>
          <Button
            size="icon-sm"
            variant={mobileOpen ? "default" : "ghost"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-settings-panel"
            aria-label={mobileOpen ? "Close settings" : "Open settings"}
            onClick={() => onMobileOpenChange(!mobileOpen)}
          >
            {mobileOpen ? <X className="size-4" /> : <Settings2 className="size-4" />}
          </Button>
        </div>
        <div className="flex gap-1 [&_nav]:flex [&_nav]:flex-1 [&_button]:flex-1">
          {nav}
        </div>
      </div>
      {mobileOpen && (
        <div
          id="mobile-settings-panel"
          className="absolute left-2 right-2 top-[calc(100%-1px)] z-30 grid max-h-[min(70vh,520px)] gap-2 overflow-y-auto rounded-md border border-line-strong bg-panel p-2 shadow-pop animate-fade-in lg:hidden"
        >
          {panels}
        </div>
      )}

      <div className={cn(collapsed && "lg:hidden")}>{connectionStatus}</div>

      {collapsed ? (
        <div className="hidden flex-1 flex-col items-center gap-1 py-2 lg:flex">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => onCollapsedChange(false)}
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant={tab === "chat" ? "secondary" : "ghost"}
            onClick={() => onTabChange("chat")}
            aria-label="Assistant"
            title="Assistant"
          >
            <MessageSquare className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant={tab === "console" ? "secondary" : "ghost"}
            onClick={() => onTabChange("console")}
            aria-label="C# console"
            title="C# console"
          >
            <Terminal className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onManageProvider}
            aria-label="Manage provider"
            title="Manage provider"
          >
            <KeyRound className="size-4" />
          </Button>
          <div className="mt-auto grid pb-2" aria-label="Status">
            <span
              tabIndex={0}
              role="img"
              aria-label={`Connection: ${connectionLabel}`}
              className="flex size-7 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", toneClass(connectionTone))}
              />
            </span>
          </div>
        </div>
      ) : (
        <div className="hidden min-h-0 flex-1 flex-col lg:flex">
          <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
            <span className="flex flex-1 items-center gap-2 text-[13px] font-semibold tracking-tight">
              <span>
                <span className="text-accent-hover">Rev</span>code
              </span>
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              className="-mr-1.5"
              onClick={() => onCollapsedChange(true)}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
            >
              <PanelLeftClose className="size-4" />
            </Button>
          </div>
          {nav}
          <div className="mt-2 grid max-h-[45%] shrink-0 gap-2 overflow-y-auto p-3 pt-0">
            {panels}
          </div>
          <p className="mt-auto px-3 pb-3 text-[10px] text-muted">Local host · Powered by Pi</p>
        </div>
      )}
    </aside>
  );
}
