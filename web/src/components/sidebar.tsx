import type { DesktopState } from "../../../src/host/desktop-types";
import { DesktopActivity } from "./desktop-activity";
import mark from "../assets/revcode-mark.svg";
import { cn } from "../lib/utils";
import {
  BookOpen,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
export type Tone = "ok" | "warn" | "danger" | "muted";
export function toneClass(tone: Tone) {
  return {
    ok: "bg-accent",
    warn: "bg-warn animate-pulse",
    danger: "bg-danger",
    muted: "bg-line-strong animate-pulse",
  }[tone];
}

export type SidebarDocument = {
  title: string;
  isFamily: boolean;
  isReadOnly: boolean;
  activeView: string;
  selection: string[];
};

export type SidebarProps = {
  desktop?: DesktopState;
  vision: boolean;
  hostOnline: boolean;
  revitConnected: boolean;
  revitVersion?: string;
  revitBuild?: string;
  document: SidebarDocument | null;
  providerConfigured: boolean;
  providerName: string;
  providerModel: string;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  mobileOpen: boolean;
  onMobileOpenChange(open: boolean): void;
  onManageProvider(): void;
  onOpenConsole(): void;
  onOpenSkills(): void;
};

/** The connection summary is rendered once per DOM: desktop card XOR mobile strip. */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia("(min-width: 64rem)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 64rem)");
    const onChange = () => setIsDesktop(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

function useConnectionSummary(hostOnline: boolean, revitConnected: boolean) {
  const tone: Tone = !hostOnline ? "danger" : revitConnected ? "ok" : "warn";
  const label = !hostOnline
    ? "Host offline"
    : revitConnected
      ? "Revit connected"
      : "Revit offline";
  return { tone, label };
}

function ConnectionCard({
  hostOnline,
  revitConnected,
  version,
  build,
}: {
  hostOnline: boolean;
  revitConnected: boolean;
  version?: string;
  build?: string;
}) {
  const { tone, label } = useConnectionSummary(hostOnline, revitConnected);
  return (
    <div className="px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "mt-[5px] size-1.5 shrink-0 rounded-full",
            toneClass(tone),
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{label}</p>
          <p
            className="mt-0.5 text-[11px] leading-4 text-muted"
            aria-live="polite"
          >
            {revitConnected
              ? "Connected to the Revit session."
              : hostOnline
                ? "Waiting for the Revit add-in…"
                : "Reconnecting automatically."}
          </p>
          {version && (
            <p className="mt-0.5 text-[11px] leading-4 text-muted">
              Revit {version}
              {build ? ` · Build ${build}` : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DocumentCard({ document }: { document: SidebarDocument | null }) {
  return (
    <div className="px-2.5 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
        Active document
      </p>
      {document ? (
        <>
          <p
            className="mt-1 truncate text-xs font-medium text-ink"
            title={document.title}
          >
            {document.title}
          </p>
          <p className="mt-0.5 text-[11px] leading-4 text-muted">
            {document.isFamily ? "Family" : "Project"}
            {document.isReadOnly ? " · Read only" : ""}
          </p>
          <div className="my-2 h-px bg-line" />
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
            View
          </p>
          <p
            className="mt-1 truncate text-xs text-ink-soft"
            title={document.activeView}
          >
            {document.activeView || "—"}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            {document.selection.length} selected element
            {document.selection.length === 1 ? "" : "s"}
          </p>
        </>
      ) : (
        <p className="mt-1 text-[11px] leading-4 text-muted">
          No document open. Open a project or family in Revit.
        </p>
      )}
    </div>
  );
}

function ProviderCard({
  configured,
  name,
  model,
  onManageProvider,
}: {
  configured: boolean;
  name: string;
  model: string;
  onManageProvider(): void;
}) {
  return (
    <button
      type="button"
      className="provider-button flex items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onManageProvider}
    >
      <KeyRound className="size-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink">
          {configured ? name : "Set up a provider"}
        </span>
        <span className="block truncate text-[11px] text-muted">
          {configured ? model || "Manage models" : "Connect a model to Pi"}
        </span>
      </span>
      <Badge variant={configured ? "accent" : "warn"} dot>
        {configured ? "Signed in" : "Not set up"}
      </Badge>
    </button>
  );
}

function ConsoleCard({ onOpenConsole }: { onOpenConsole(): void }) {
  return (
    <button
      type="button"
      className="console-button flex items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      onClick={onOpenConsole}
    >
      <Terminal className="size-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink">
          C# console
        </span>
        <span className="block truncate text-[11px] text-muted">
          Run snippets against Revit
        </span>
      </span>
    </button>
  );
}

function Brand() {
  return (
    <span className="flex flex-1 items-center gap-2 text-[13px] font-semibold tracking-tight">
      <img src={mark} alt="" className="size-5 rounded-[5px]" />
      <span>
        <span className="text-accent-hover">Rev</span>code
      </span>
    </span>
  );
}

export function Sidebar(props: SidebarProps) {
  const {
    hostOnline,
    revitConnected,
    providerConfigured,
    collapsed,
    onCollapsedChange,
    mobileOpen,
    onMobileOpenChange,
    onManageProvider,
    onOpenConsole,
  } = props;
  const isDesktop = useIsDesktop();
  const { tone, label } = useConnectionSummary(hostOnline, revitConnected);
  const panels: ReactNode = (
    <>
      <DocumentCard document={props.document} />
      <section aria-label="Agent tools" className="px-2.5 py-2">
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted">
          Agent tools
        </h2>
        <ul className="mt-3 space-y-3">
          {[
            {
              name: "revit_execute_csharp",
              label: "Execute Revit C#",
              description: "Inspect and edit the model",
              vision: false,
              desktop: false,
            },
            {
              name: "revit_capture_view",
              label: "Capture a view",
              description: "Inspect an exported Revit view",
              vision: true,
              desktop: false,
            },
            {
              name: "revit_ui_observe",
              label: "Observe desktop",
              description: "See Revit and its dialogs",
              vision: true,
              desktop: true,
            },
            {
              name: "revit_ui_action",
              label: "Control desktop",
              description: "Move, click, scroll and type",
              vision: true,
              desktop: true,
            },
          ].map((tool) => {
            const reason = !hostOnline
              ? "Host offline"
              : !revitConnected
                ? "Revit offline"
                : !providerConfigured
                  ? "Connect a provider"
                  : tool.vision && !props.vision
                    ? "Needs a vision model"
                    : tool.desktop && !props.desktop?.available
                      ? "Desktop unavailable"
                      : tool.desktop && props.desktop?.status === "unknown"
                        ? "Needs review"
                        : "Available";
            return (
              <li key={tool.name} title={tool.name} className="text-xs">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 shrink-0 rounded-full ${reason === "Available" ? "bg-accent" : "bg-line-strong"}`}
                  />
                  <span className="font-medium">{tool.label}</span>
                </div>
                <p className="mt-1 text-[10px] text-muted">
                  {tool.description}
                </p>
                <p className="mt-0.5 break-all font-mono text-[9px] text-muted">
                  {tool.name}
                </p>
                <p
                  className={`mt-0.5 text-[10px] ${reason === "Available" ? "text-accent" : "text-muted"}`}
                >
                  {reason}
                </p>
              </li>
            );
          })}
        </ul>
      </section>
      {props.desktop?.activity?.length || props.desktop?.error ? (
        <div className="border-t border-line px-2.5 py-3">
          <DesktopActivity state={props.desktop} compact />
        </div>
      ) : null}
      <Button variant="secondary" onClick={props.onOpenSkills}>
        <BookOpen className="size-4" />
        Skills & Markdown
      </Button>
      <ConsoleCard onOpenConsole={onOpenConsole} />
      <ProviderCard
        configured={props.providerConfigured}
        name={props.providerName}
        model={props.providerModel}
        onManageProvider={onManageProvider}
      />
    </>
  );
  return (
    <aside
      aria-label="Revcode controls"
      className={cn(
        "relative z-20 flex shrink-0 flex-col border-b border-line bg-panel lg:h-full lg:border-b-0 lg:border-r lg:transition-[width] lg:duration-200",
        collapsed ? "lg:w-12" : "lg:w-[248px]",
      )}
    >
      {/* Mobile top bar */}
      <div className="flex items-center gap-2 px-3 py-2 lg:hidden">
        <Brand />
        {!isDesktop && !mobileOpen && (
          <span
            className="flex min-w-0 shrink-0 items-center gap-1.5 text-[11px] text-muted"
            aria-live="polite"
          >
            <span
              aria-hidden="true"
              className={cn("size-1.5 shrink-0 rounded-full", toneClass(tone))}
            />
            <span className="max-w-28 truncate">{label}</span>
          </span>
        )}
        <Button
          size="icon-sm"
          variant={mobileOpen ? "default" : "ghost"}
          aria-expanded={mobileOpen}
          aria-controls="mobile-settings-panel"
          aria-label={mobileOpen ? "Close settings" : "Open settings"}
          onClick={() => onMobileOpenChange(!mobileOpen)}
        >
          {mobileOpen ? (
            <X className="size-4" />
          ) : (
            <Settings2 className="size-4" />
          )}
        </Button>
      </div>
      {!isDesktop && mobileOpen && (
        <div
          id="mobile-settings-panel"
          className="absolute left-2 right-2 top-[calc(100%-1px)] z-30 grid max-h-[min(70vh,520px)] gap-2 overflow-y-auto rounded-md border border-line-strong bg-panel p-2 shadow-pop animate-fade-in lg:hidden"
        >
          {panels}
          <ConnectionCard
            hostOnline={hostOnline}
            revitConnected={revitConnected}
            version={props.revitVersion}
            build={props.revitBuild}
          />
        </div>
      )}
      {/* Desktop: collapsed rail */}
      {isDesktop && collapsed ? (
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
            variant="ghost"
            disabled={!hostOnline}
            onClick={onManageProvider}
            aria-label="Manage provider"
            title="Manage provider"
          >
            <KeyRound className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onOpenConsole}
            aria-label="C# console"
            title="C# console"
          >
            <Terminal className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={props.onOpenSkills}
            aria-label="Skills & Markdown"
            title="Skills & Markdown"
          >
            <BookOpen className="size-4" />
          </Button>
          <div className="mt-auto grid pb-2" aria-label="Status">
            <Tooltip
              content={`Revit session: ${revitConnected ? "connected" : "offline"}`}
            >
              <span
                tabIndex={0}
                role="img"
                aria-label={`Revit session: ${revitConnected ? "connected" : "offline"}`}
                className="flex size-7 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 rounded-full", toneClass(tone))}
                />
              </span>
            </Tooltip>
            <Tooltip
              content={`Provider: ${providerConfigured ? "signed in" : "not set up"}`}
            >
              <span
                tabIndex={0}
                role="img"
                aria-label={`Provider: ${providerConfigured ? "signed in" : "not set up"}`}
                className="flex size-7 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    toneClass(providerConfigured ? "ok" : "warn"),
                  )}
                />
              </span>
            </Tooltip>
          </div>
        </div>
      ) : isDesktop ? (
        <div className="hidden min-h-0 flex-1 flex-col lg:flex">
          <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
            <Brand />
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
          <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-3">
            {panels}
          </div>
          <ConnectionCard
            hostOnline={hostOnline}
            revitConnected={revitConnected}
            version={props.revitVersion}
            build={props.revitBuild}
          />
          <p className="mt-auto px-3 pb-3 text-[11px] text-muted">
            Local host · Powered by Pi
          </p>
        </div>
      ) : null}
    </aside>
  );
}
