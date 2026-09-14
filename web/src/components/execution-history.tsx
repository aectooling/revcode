import { DiagnosticSource } from "./diagnostic-source";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "./ui/badge";
export type Operation = {
  operationId: string;
  runId?: string;
  executionMode?: string;
  toolCallId?: string;
  code?: string;
  verify?: { code: string };
  steps?: { name: string; code: string }[];
  mode: "query" | "modify" | "api" | "batch";
  status: string;
  createdAt: string;
  result?: unknown;
  error?: string;
  logs?: string[];
  transactionStatus?: string;
  elapsedMs?: number;
  diagnostics?: {
    stepName?: string;
    stepIndex?: number;
    severity: string;
    message: string;
    line?: number;
    column?: number;
  }[];
};

function statusVariant(status: string) {
  if (status === "failed" || status === "unknown") return "danger" as const;
  if (["queued", "running", "compiling"].includes(status))
    return "warn" as const;
  return "neutral" as const;
}

import { HighlightedCode } from "./highlighted-code";
export function OperationList({ operations }: { operations: Operation[] }) {
  const [disclosures, setDisclosures] = useState<Record<string, boolean>>({});
  return (
    <div className="grid gap-1">
      {" "}
      {operations.map((operation) => {
        const open = !["succeeded", "cancelled"].includes(operation.status);
        return (
          <details
            className="operation group overflow-hidden rounded-[5px] border border-line bg-surface text-xs transition-colors hover:border-line-strong"
            key={operation.operationId}
            open={disclosures[operation.operationId] ?? open}
            onToggle={(event) => {
              const value = event.currentTarget.open;
              setDisclosures((current) =>
                current[operation.operationId] === value
                  ? current
                  : { ...current, [operation.operationId]: value },
              );
            }}
          >
            <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 outline-none marker:content-none focus-visible:bg-surface-muted [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 shrink-0 text-muted transition-transform group-open:rotate-90" />
              <Badge variant={statusVariant(operation.status)}>
                {operation.status === "queued"
                  ? "Waiting for Revit"
                  : operation.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-medium text-ink-soft">
                {operation.mode === "batch"
                  ? "Atomic batch"
                  : operation.mode === "modify"
                    ? "Model change"
                    : operation.mode === "api"
                      ? "API operation"
                      : "Model query"}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted">
                {operation.elapsedMs !== undefined
                  ? `${(operation.elapsedMs / 1000).toFixed(2)}s`
                  : ""}
              </span>
            </summary>
            <div className="grid gap-1.5 border-t border-line bg-surface-muted px-2 py-2">
              <p className="break-all font-mono text-[11px] text-muted">
                {operation.operationId}
                {operation.transactionStatus
                  ? ` · Transaction: ${operation.transactionStatus}`
                  : ""}
              </p>
              {operation.code && <HighlightedCode code={operation.code} />}
              {operation.steps?.map((step, index) => {
                const receipt = (
                  operation.result as
                    | {
                        steps?: {
                          status: string;
                          result?: unknown;
                          error?: string;
                        }[];
                      }
                    | undefined
                )?.steps?.[index];
                return (
                  <details
                    key={index}
                    className="rounded border border-line p-2"
                  >
                    <summary>
                      {index + 1}. {step.name} ·{" "}
                      {receipt?.status ??
                        (operation.transactionStatus === "NotStarted" ||
                        ["failed", "cancelled"].includes(operation.status)
                          ? "notRun"
                          : operation.status === "unknown"
                            ? "unknown"
                            : "awaiting outcome")}
                    </summary>
                    <HighlightedCode code={step.code} label={step.name} />
                    {receipt && (
                      <pre className="overflow-auto whitespace-pre-wrap">
                        {JSON.stringify(receipt, null, 2)}
                      </pre>
                    )}
                  </details>
                );
              })}
              {operation.error && (
                <p className="text-[11px] leading-relaxed text-danger">
                  {operation.error}
                </p>
              )}
              {operation.diagnostics?.map((diagnostic, index) => (
                <DiagnosticSource
                  key={index}
                  diagnostic={diagnostic}
                  source={operation}
                />
              ))}
              {operation.verify && (
                <HighlightedCode
                  code={operation.verify.code}
                  label="Verification"
                />
              )}
              {!!operation.logs?.length && (
                <>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                    Logs
                  </p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-soft">
                    {operation.logs.join("\n")}
                  </pre>
                </>
              )}
              {operation.result !== undefined && (
                <>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                    Result
                  </p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-soft">
                    {JSON.stringify(operation.result, null, 2)}
                  </pre>
                </>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export type RunSummary = import("../../../src/host/history-types").RunSummary;
export type RunDetail = Omit<import("../../../src/host/history-types").RunDetail, "operations"> & {
  operations: Operation[];
};

type Api = <T>(path: string, body?: unknown) => Promise<T>;
export function ExecutionHistory({
  operations,
  api,
  online,
  activity,
  selectedRun,
  onSelectRun,
  onJump,
  onAuthor,
  loadImage,
  onOpenSkill,
}: {
  operations: Operation[];
  api: Api;
  online: boolean;
  activity: unknown;
  selectedRun: string;
  onSelectRun(id: string): void;
  onJump(detail: RunDetail): void;
  onAuthor(runs: RunSummary[]): void;
  loadImage(id: string): Promise<Blob>;
  onOpenSkill(id: string): void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const atLiveEdge = useRef(true);
  const [newActivity, setNewActivity] = useState(false);
  const [queuedRuns, setQueuedRuns] = useState<RunSummary[]>();
  const [details, setDetails] = useState<Record<string, RunDetail>>({});
  const openRuns = useRef(new Set<string>());
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrors] = useState(false);
  const [tool, setTool] = useState("");
  const [legacyOperations, setLegacyOperations] = useState<Operation[]>([]);
  const [legacyCursor, setLegacyCursor] = useState<string>();
  const [legacyLoaded, setLegacyLoaded] = useState(false);
  const loadLegacy = async () => {
    try {
      const page = await api<{ operations: Operation[]; nextCursor?: string }>(
        `/api/history/legacy${legacyCursor ? `?before=${encodeURIComponent(legacyCursor)}` : ""}`,
      );
      setLegacyOperations((current) => [
        ...current,
        ...page.operations.filter(
          (operation) =>
            !current.some((old) => old.operationId === operation.operationId),
        ),
      ]);
      setLegacyCursor(page.nextCursor);
      setLegacyLoaded(true);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retention, setRetention] = useState("");
  const [sources, setSources] = useState<RunSummary[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [large, setLarge] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const wide = viewport.width >= 1024;
  const [sizes, setSizes] = useState(() => {
    try {
      return JSON.parse(
        localStorage.getItem("revcode.inspector.size") || "{}",
      ) as { width?: number; height?: number };
    } catch {
      return {};
    }
  });
  const max = wide
    ? Math.max(
        280,
        viewport.width -
          (document
            .querySelector('[aria-label="Revcode controls"]')
            ?.getBoundingClientRect().width ?? 248) -
          320,
      )
    : Math.max(160, viewport.height - 300);
  const size = Math.min(
    max,
    Math.max(
      wide ? 280 : 140,
      large
        ? wide
          ? viewport.width * 0.6
          : viewport.height * 0.7
        : wide
          ? (sizes.width ?? 320)
          : (sizes.height ?? 240),
    ),
  );
  useEffect(() => {
    const update = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const resize = (value: number) => {
    setLarge(false);
    setSizes((current) => {
      const next = {
        ...current,
        [wide ? "width" : "height"]: Math.max(
          wide ? 280 : 140,
          Math.min(max, value),
        ),
      };
      try {
        localStorage.setItem("revcode.inspector.size", JSON.stringify(next));
      } catch {}
      return next;
    });
  };
  const queryVersion = useRef(0);
  const load = async (older = false, reset = false) => {
    const version = queryVersion.current;
    if (!online) return;
    setLoading(true);
    try {
      const query = new URLSearchParams({
        search,
        errorsOnly: String(errorsOnly),
        tool,
        ...(older && cursor ? { cursor } : {}),
      });
      const data = await api<{
        runs: RunSummary[];
        nextCursor?: string;
        retention?: unknown;
      }>(`/api/runs?${query}`);
      if (version !== queryVersion.current) return;
      setRuns((current) => {
        if (
          !older &&
          !reset &&
          !atLiveEdge.current &&
          current.length &&
          data.runs[0]?.id !== current[0]?.id
        ) {
          setQueuedRuns(data.runs);
          setNewActivity(true);
          return current;
        }
        return older
          ? [
              ...current,
              ...data.runs.filter(
                (run) => !current.some((old) => old.id === run.id),
              ),
            ]
          : reset
            ? data.runs
            : [
                ...data.runs,
                ...current.filter(
                  (run) => !data.runs.some((next) => next.id === run.id),
                ),
              ];
      });
      if (older || reset) setCursor(data.nextCursor);
      setRetention(
        typeof data.retention === "string"
          ? data.retention
          : JSON.stringify(data.retention ?? ""),
      );
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "History unavailable.",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    queryVersion.current++;
    setNewActivity(false);
    setQueuedRuns(undefined);
    const timer = setTimeout(() => void load(false, true), 200);
    return () => clearTimeout(timer);
  }, [online, search, errorsOnly, tool]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [activity]);
  const open = async (id: string) => {
    try {
      const detail = await api<RunDetail>(
        `/api/runs/${encodeURIComponent(id)}`,
      );
      setDetails((current) => ({ ...current, [id]: detail }));
    } catch (reason) {
      setError(String(reason));
    }
  };
  useEffect(() => {
    const ids = new Set(openRuns.current);
    if (selectedRun && !["manual", "older"].includes(selectedRun))
      ids.add(selectedRun);
    for (const id of ids) void open(id);
  }, [selectedRun, activity]);
  const visible = selectedRun
    ? runs.some((run) => run.id === selectedRun)
      ? runs.filter((run) => run.id === selectedRun)
      : details[selectedRun]
        ? [details[selectedRun].run]
        : []
    : runs;
  const unlinked = [
    ...operations,
    ...legacyOperations.filter(
      (operation) =>
        !operations.some(
          (current) => current.operationId === operation.operationId,
        ),
    ),
  ];
  const manual = unlinked.filter(
    (op) => !op.runId && op.executionMode === "manual",
  );
  const legacy = unlinked.filter(
    (op) => !op.runId && op.executionMode !== "manual",
  );
  const toolNames = [...new Set(runs.flatMap((run) => run.toolNames))].sort();
  return (
    <aside
      aria-label="Execution history"
      className="relative flex min-h-0 shrink-0 flex-col border-t border-line bg-panel p-3 lg:border-l lg:border-t-0"
      style={wide ? { width: size } : { height: collapsed ? 48 : size }}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-label={wide ? "Resize inspector width" : "Resize inspector height"}
        aria-orientation={wide ? "vertical" : "horizontal"}
        aria-valuemin={wide ? 280 : 140}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(size)}
        className={`absolute z-10 touch-none focus-visible:bg-accent ${wide ? "bottom-0 left-0 top-0 w-2 cursor-col-resize" : "left-0 right-0 top-0 h-2 cursor-row-resize"}`}
        onKeyDown={(event) => {
          if (
            [
              "ArrowLeft",
              "ArrowUp",
              "ArrowRight",
              "ArrowDown",
              "Home",
              "End",
            ].includes(event.key)
          ) {
            event.preventDefault();
            resize(
              event.key === "Home"
                ? 140
                : event.key === "End"
                  ? max
                  : size +
                    (["ArrowLeft", "ArrowUp"].includes(event.key) ? 20 : -20),
            );
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            resize(
              wide
                ? viewport.width - event.clientX
                : viewport.height - event.clientY,
            );
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      />
      <div className="flex shrink-0 items-center gap-2">
        <button
          className="flex-1 text-left text-[13px] font-semibold"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          Execution history
        </button>
        <button
          className="text-xs text-accent"
          onClick={() => {
            setCollapsed(false);
            setLarge(!large);
          }}
        >
          {large ? "Restore" : "Expand"}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="grid shrink-0 gap-2 py-2 text-xs">
            <input
              aria-label="Search run prompts"
              placeholder="Search all retained prompts…"
              className="w-full rounded border border-line bg-surface p-2"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Run filter"
              className="min-w-0 rounded border border-line bg-surface p-1"
              value={selectedRun}
              onChange={(e) => onSelectRun(e.target.value)}
            >
              <option value="">All runs</option>
              {selectedRun &&
                !["manual", "older"].includes(selectedRun) &&
                !runs.some((run) => run.id === selectedRun) && (
                  <option value={selectedRun}>Selected run</option>
                )}
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  Run {run.number} · {run.promptPreview} · {run.status}
                </option>
              ))}
              {!!manual.length && (
                <option value="manual">Manual console</option>
              )}
              {!!legacy.length && <option value="older">Older history</option>}
            </select>
            <div className="flex flex-wrap items-center gap-2">
              <label>
                <input
                  type="checkbox"
                  checked={errorsOnly}
                  onChange={(e) => setErrors(e.target.checked)}
                />{" "}
                Errors only
              </label>
              <select
                aria-label="Tool filter"
                className="min-w-0 max-w-full bg-surface"
                value={tool}
                onChange={(e) => setTool(e.target.value)}
              >
                <option value="">All tools</option>
                {toolNames.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
              {(search || tool || errorsOnly) && (
                <button
                  onClick={() => {
                    setSearch("");
                    setTool("");
                    setErrors(false);
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
            {!!sources.length && (
              <button
                className="text-accent"
                onClick={() =>
                  onAuthor([...sources].sort((a, b) => a.number - b.number))
                }
              >
                Create skill from {sources.length} selected runs
              </button>
            )}
            {!online && (
              <p role="status">Host offline · cached history is stale.</p>
            )}
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            {newActivity && (
              <button
                className="text-accent"
                onClick={() => {
                  if (queuedRuns) setRuns(queuedRuns);
                  setQueuedRuns(undefined);
                  setNewActivity(false);
                  atLiveEdge.current = true;
                  onSelectRun("");
                  scroll.current?.scrollTo({ top: 0 });
                }}
              >
                New activity · Jump to latest
              </button>
            )}
          </div>
          <div
            ref={scroll}
            onScroll={() => {
              atLiveEdge.current = (scroll.current?.scrollTop ?? 0) < 40;
            }}
            className="min-h-0 flex-1 space-y-2 overflow-auto text-xs"
            style={{ overflowAnchor: "auto" }}
          >
            {visible.map((run) => (
              <details
                key={run.id}
                className="rounded border border-line bg-surface"
                open={selectedRun === run.id || undefined}
                onToggle={(e) => {
                  if (e.currentTarget.open) {
                    openRuns.current.add(run.id);
                    void open(run.id);
                  } else openRuns.current.delete(run.id);
                }}
              >
                <summary className="cursor-pointer p-2">
                  <strong>Run {run.number}</strong> · {run.promptPreview}
                  <p className="mt-1 text-muted">
                    {run.status === "finished" ? "Finished" : run.status} ·{" "}
                    {run.callCount} {run.callCount === 1 ? "call" : "calls"}
                    {run.failedCalls
                      ? ` · ${run.failedCalls} failed ${run.failedCalls === 1 ? "call" : "calls"}`
                      : ""}
                  </p>
                </summary>
                <div className="space-y-2 border-t border-line p-2">
                  <label>
                    <input
                      type="checkbox"
                      checked={sources.some((source) => source.id === run.id)}
                      onChange={(e) =>
                        setSources((current) =>
                          e.target.checked
                            ? [...current, run]
                            : current.filter((source) => source.id !== run.id),
                        )
                      }
                    />{" "}
                    Select as skill source
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="text-accent"
                      onClick={() => onAuthor([run])}
                    >
                      Create skill from this run
                    </button>
                    <button
                      className="text-accent"
                      onClick={async () => {
                        try {
                          if (details[run.id]) onJump(details[run.id]);
                          else {
                            const detail = await api<RunDetail>(
                              `/api/runs/${encodeURIComponent(run.id)}`,
                            );
                            onJump(detail);
                          }
                        } catch (reason) {
                          setError(String(reason));
                        }
                      }}
                    >
                      Jump to message
                    </button>
                  </div>
                  {!run.detailsAvailable && (
                    <p>Recorded details are unavailable or expired.</p>
                  )}
                  {details[run.id] ? (
                    <RunContents
                      detail={details[run.id]}
                      errorsOnly={errorsOnly}
                      tool={tool}
                      loadImage={loadImage}
                      onOpenSkill={onOpenSkill}
                    />
                  ) : (
                    run.detailsAvailable && <p>Loading details…</p>
                  )}
                </div>
              </details>
            ))}
            {!visible.length &&
              !loading &&
              !["manual", "older"].includes(selectedRun) && (
                <p className="py-3 text-muted">
                  {search || tool || errorsOnly || selectedRun
                    ? "No matching runs."
                    : "Runs and tool calls will appear here after a message."}
                </p>
              )}
            {(!selectedRun || selectedRun === "manual") && !!manual.length && (
              <details>
                <summary>Manual console</summary>
                <OperationList operations={manual} />
              </details>
            )}
            {(!selectedRun || selectedRun === "older") && !!legacy.length && (
              <details>
                <summary>Older history</summary>
                <OperationList operations={legacy} />
              </details>
            )}
            {(!legacyLoaded || legacyCursor) && (
              <button disabled={!online} onClick={() => void loadLegacy()}>
                Load older manual and legacy operations
              </button>
            )}
            {loading && <p role="status">Loading history…</p>}
            {cursor && (
              <button disabled={loading} onClick={() => void load(true)}>
                Load older runs
              </button>
            )}
            {retention && (
              <details className="text-muted">
                <summary>History retention</summary>
                <p className="break-words">{retention}</p>
              </details>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function RunContents({
  detail,
  errorsOnly,
  tool,
  loadImage,
  onOpenSkill,
}: {
  detail: RunDetail;
  errorsOnly: boolean;
  tool: string;
  loadImage(id: string): Promise<Blob>;
  onOpenSkill(id: string): void;
}) {
  const [all, setAll] = useState(false);
  const calls = detail.calls.filter(
    (call) =>
      all ||
      ((!errorsOnly || ["failed", "unknown"].includes(call.status)) &&
        (!tool || call.name === tool)),
  );
  return (
    <>
      <p className="whitespace-pre-wrap break-words">
        {detail.messages.find((message) => message.role === "user")?.text ??
          detail.run.promptPreview}
      </p>
      {detail.missingEvidence?.map((text) => (
        <p key={text} className="text-warn">
          {text}
        </p>
      ))}
      <details>
        <summary>Recorded context and skills</summary>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">
          {JSON.stringify(
            {
              provider: detail.run.provider,
              model: detail.run.model,
              context: detail.context ?? "Unavailable",
              selectedSkills: detail.selectedSkills,
              readSkills: detail.readSkills,
              availableSkills: detail.availableSkills,
              authoringReads: detail.authoringReads,
            },
            null,
            2,
          )}
        </pre>
      </details>
      {(errorsOnly || tool) && (
        <button className="text-accent" onClick={() => setAll(!all)}>
          {all ? "Show matching calls" : "Reveal full run"}
        </button>
      )}
      {!detail.calls.length && <p>No tools were called in this run.</p>}
      {calls.map((call) => (
        <details key={call.id} className="rounded border border-line p-2">
          <summary>
            {call.sequence}. {call.name} · {call.status}
            {call.endedAt
              ? ` · ${Math.max(0, Date.parse(call.endedAt) - Date.parse(call.startedAt))} ms`
              : ""}
          </summary>
          <ToolCode argumentsValue={call.arguments} />
          <p className="mt-2 text-muted">Inputs</p>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
          {call.error && <p className="text-danger">{call.error}</p>}
          {call.artifacts?.map((id) => (
            <HistoryImage key={id} id={id} load={loadImage} />
          ))}
          {savedSkillId(call.result) && (
            <button
              className="text-accent"
              onClick={() => onOpenSkill(savedSkillId(call.result)!)}
            >
              Preview saved skill
            </button>
          )}
          {call.result !== undefined && (
            <>
              <p className="text-muted">Result</p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">
                {JSON.stringify(call.result, null, 2)}
              </pre>
            </>
          )}
          <OperationList
            operations={detail.operations.filter((operation) =>
              call.operationIds.includes(operation.operationId),
            )}
          />
        </details>
      ))}
      <OperationList
        operations={detail.operations.filter(
          (operation) =>
            !detail.calls.some((call) =>
              call.operationIds.includes(operation.operationId),
            ),
        )}
      />
    </>
  );
}

function savedSkillId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return;
  const data = result as {
    id?: unknown;
    revision?: unknown;
    details?: unknown;
    content?: { type: string; text?: string }[];
  };
  if (typeof data.id === "string" && typeof data.revision === "string")
    return data.id;
  if (data.details) return savedSkillId(data.details);
  for (const item of data.content ?? []) {
    if (item.type === "text" && item.text) {
      try {
        const id = savedSkillId(JSON.parse(item.text));
        if (id) return id;
      } catch {}
    }
  }
}

function HistoryImage({
  id,
  load,
}: {
  id: string;
  load(id: string): Promise<Blob>;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return (
    <div className="my-2">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open recorded image in new tab"
        >
          <img
            src={url}
            alt="Recorded tool image"
            className="max-h-80 max-w-full object-contain"
          />
        </a>
      ) : (
        <button
          className="text-accent"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              setUrl(URL.createObjectURL(await load(id)));
            } catch (reason) {
              setError(String(reason));
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? "Loading image…" : "Preview recorded image"}
        </button>
      )}
      {error && (
        <p role="status" className="text-warn">
          {error}
        </p>
      )}
    </div>
  );
}

function ToolCode({ argumentsValue }: { argumentsValue: unknown }) {
  if (!argumentsValue || typeof argumentsValue !== "object") return null;
  const args = argumentsValue as {
    code?: unknown;
    steps?: { code?: unknown; name?: string }[];
    verify?: { code?: unknown };
  };
  return (
    <>
      {typeof args.code === "string" && (
        <HighlightedCode code={args.code} label="Submitted C#" />
      )}
      {Array.isArray(args.steps) &&
        args.steps.map(
          (step, index) =>
            typeof step.code === "string" && (
              <HighlightedCode
                key={index}
                code={step.code}
                label={step.name ?? `Step ${index + 1}`}
              />
            ),
        )}
      {typeof args.verify?.code === "string" && (
        <HighlightedCode code={args.verify.code} label="Verification" />
      )}
    </>
  );
}
