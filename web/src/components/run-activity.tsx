import { ChevronDown, ChevronRight, ChevronUp, CircleAlert, CircleCheck, Loader2, Wrench } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RunDetail, RunSummary, ToolCallRecord } from "../../../src/host/history-types";

function formatValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
}

function WorkingTime({ run, busy }: { run?: RunSummary; busy: boolean }) {
  const [now, setNow] = useState(Date.now);
  const running = run ? run.status === "running" && busy : busy;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, run?.id]);
  const start = Date.parse(run?.startedAt ?? "");
  const end = running ? now : Date.parse(run?.endedAt ?? "");
  const seconds = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : null;
  const duration = seconds === null ? "" : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  const label = running ? "Working" : run?.status === "failed" ? "Failed" : run?.status === "interrupted" ? "Interrupted" : run?.status === "running" ? "Reconnecting" : "Worked";
  const durationPrefix = run?.status === "failed" || run?.status === "interrupted" ? "after" : "for";
  return <span aria-live="off" className="tabular-nums">{label}{duration ? ` ${durationPrefix} ${duration}` : running ? "…" : ""}</span>;
}

function ToolCard({ call }: { call: ToolCallRecord }) {
  const [open, setOpen] = useState(call.status === "failed");
  const id = useId();
  useEffect(() => { if (call.status === "failed") setOpen(true); }, [call.status]);
  const preview = formatValue(call.status === "running" ? call.arguments : call.error ?? call.result).replace(/\s+/g, " ").slice(0, 240);
  const status = call.status === "running" ? "Running" : call.status === "failed" ? "Failed" : call.status === "unknown" ? "Outcome unknown" : "Done";
  return <div className={`overflow-hidden rounded-[5px] border bg-surface text-xs ${call.status === "failed" ? "border-danger/30" : "border-line hover:border-line-strong"}`}>
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-2 py-1 text-left outline-none focus-visible:bg-surface-muted">
      <ChevronRight className={`size-3 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
      <Wrench className="size-3 shrink-0 text-muted" />
      <span className="min-w-0 shrink truncate font-mono text-[11px] font-medium" title={call.name}>{call.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{preview}</span>
      <span role="img" aria-label={status} className="flex shrink-0">
        {call.status === "running" ? <Loader2 className="size-3.5 animate-spin text-accent" /> : call.status === "failed" || call.status === "unknown" ? <CircleAlert className={`size-3.5 ${call.status === "failed" ? "text-danger" : "text-warn"}`} /> : <CircleCheck className="size-3.5 text-muted" />}
      </span>
    </button>
    {open && <div id={id} className="border-t border-line bg-surface-muted">
      <div className="border-b border-line px-2 py-1.5">
        <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">Input</p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-soft">{formatValue(call.arguments)}</pre>
      </div>
      <div className="px-2 py-1.5">
        <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">{call.error ? "Error" : "Output"}</p>
        <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed ${call.status === "failed" ? "text-danger" : "text-ink-soft"}`}>{formatValue(call.error ?? call.result) || (call.status === "running" ? "Running…" : "No output recorded.")}</pre>
        {call.error && call.result !== undefined && <>
          <p className="mb-0.5 mt-2 text-[10px] font-medium uppercase tracking-wider text-muted">Output</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-soft">{formatValue(call.result)}</pre>
        </>}
      </div>
    </div>}
  </div>;
}

export function RunActivity({ runId, summary, busy, connected, api, onViewTools, children }: {
  runId: string;
  summary?: RunSummary;
  busy: boolean;
  connected: boolean;
  api<T>(path: string): Promise<T>;
  onViewTools?(id: string): void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [detail, setDetail] = useState<RunDetail>();
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const callsId = useId();
  const run = summary ?? detail?.run;
  const running = run?.status === "running" || (!run && busy);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { rootMargin: "200px" });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !connected || summary?.detailsAvailable === false) return;
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const value = await api<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
        if (active) { setDetail(value); setError(false); }
      } catch { if (active) setError(true); }
      if (active && running) timer = window.setTimeout(refresh, 1000);
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, runId, visible, connected, running, summary?.callCount, summary?.failedCalls, summary?.endedAt, summary?.detailsAvailable]);
  const calls = run?.detailsAvailable === false ? [] : detail?.calls ?? [];
  const hidden = Math.max(0, calls.length - 3);
  return <div ref={root}>
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 pb-3 text-[13px] text-muted">
      <WorkingTime run={run} busy={busy} />
      {!!run?.callCount && onViewTools && <button type="button" onClick={() => onViewTools(runId)} className="text-[11px] hover:text-ink focus-visible:outline-accent" aria-label="View tools">{run.callCount} tool call{run.callCount === 1 ? "" : "s"} · View tools</button>}
    </div>
    <div className="grid gap-3">
      {children}
      {calls.length > 0 && <section aria-label="Tool calls" className="min-w-0">
        {hidden > 0 && <button type="button" aria-expanded={expanded} aria-controls={callsId} onClick={() => setExpanded(!expanded)} className="mb-1 flex min-h-7 w-full items-center justify-center gap-1 rounded-sm text-[11px] text-ink-soft hover:text-ink focus-visible:outline-accent">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          {expanded ? "Show recent calls" : `${hidden} earlier tool call${hidden === 1 ? "" : "s"}`}
        </button>}
        <div id={callsId} className="grid gap-1">{(expanded ? calls : calls.slice(-3)).map(call => <ToolCard key={call.id} call={call} />)}</div>
      </section>}
      {(error || run?.detailsAvailable === false) && <p className="text-xs text-muted">{run?.detailsAvailable === false ? "Tool details have expired." : "Couldn’t load tool details."}</p>}
      {!error && run?.detailsAvailable !== false && detail?.missingEvidence?.map((notice, index) => <p key={index} className="text-xs text-muted">{notice}</p>)}
    </div>
  </div>;
}
