import { toolLabel } from "../lib/tool-label";
import { ChevronDown, PanelRightClose, PanelRightOpen, Maximize2, Minimize2, ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HighlightedCode } from "./highlighted-code";
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

function ExecutionResult({ result, error }: { result?: unknown; error?: string }) {
  const value = error ? (result === undefined ? { error } : { error, result }) : result;
  if (value === undefined) return null;
  return <HighlightedCode code={JSON.stringify(value, null, 2)} language="json" label="Result" />;
}

function OperationList({ operations }: { operations: Operation[] }) {
  return <div className="min-w-0 divide-y divide-line">
    {operations.map(operation => <section key={operation.operationId} className="min-w-0 py-2">
      <h3 className="truncate text-xs font-medium">Execute Revit C# · {operation.status}</h3>
      <ToolCode argumentsValue={operation} />
      <ExecutionResult result={operation.result} error={operation.error} />
    </section>)}
  </div>;
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
  loadImage(id: string): Promise<Blob>;
  onOpenSkill(id: string): void;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const atLiveEdge = useRef(true);
  const [newActivity, setNewActivity] = useState(false);
  const [queuedRuns, setQueuedRuns] = useState<RunSummary[]>();
  const [details, setDetails] = useState<Record<string, RunDetail>>({});
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
  }, [online]);
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
    const ids = selectedRun && !["manual", "older"].includes(selectedRun)
      ? [selectedRun] : runs.filter(run => run.detailsAvailable).map(run => run.id);
    for (const id of ids) void open(id);
  }, [selectedRun, activity, runs]);
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
  return (
    <aside
      aria-label="Execution history"
      className="relative flex min-h-0 min-w-0 shrink-0 flex-col border-t border-line bg-panel p-3 lg:border-l lg:border-t-0"
      style={wide ? { width: collapsed ? 48 : size } : { height: collapsed ? 48 : size }}
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
      <div className={`flex shrink-0 items-center gap-1 ${collapsed && wide ? "flex-col" : ""}`}>
        <button className="rounded p-1.5 text-muted hover:bg-surface-muted" aria-label={collapsed ? "Show execution history" : "Collapse execution history"} title={collapsed ? "Show execution history" : "Collapse execution history"} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          {wide ? (collapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />) : <ChevronDown className={`size-4 ${collapsed ? "rotate-180" : ""}`} />}
        </button>
        {!(collapsed && wide) && <h2 className="flex-1 text-[13px] font-semibold">Execution history</h2>}
        {!collapsed && <button className="rounded p-1.5 text-muted hover:bg-surface-muted" aria-label={large ? "Restore history size" : "Expand execution history"} title={large ? "Restore history size" : "Expand execution history"} onClick={() => setLarge(!large)}>
          {large ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>}
      </div>
      {!collapsed && (
        <>
          <div className="grid shrink-0 gap-2 py-2 text-xs">
            <div aria-label="Run filter" className="flex gap-1 overflow-x-auto pb-1">
              {[{ id: "", label: "All runs" }, ...runs.map(run => ({ id: run.id, label: `Run ${run.number}` })),
                ...(selectedRun && !["manual", "older"].includes(selectedRun) && !runs.some(run => run.id === selectedRun) ? [{ id: selectedRun, label: "Selected run" }] : []),
                ...(manual.length ? [{ id: "manual", label: "Manual" }] : []), ...(legacy.length ? [{ id: "older", label: "Older" }] : [])].map(item => (
                <button key={item.id} aria-pressed={selectedRun === item.id} onClick={() => onSelectRun(item.id)} className={`shrink-0 rounded-full border px-3 py-1.5 transition-colors ${selectedRun === item.id ? "border-accent/30 bg-accent-soft text-accent" : "border-line text-muted hover:bg-surface-muted"}`}>{item.label}</button>
              ))}
            </div>
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
            className="min-h-0 min-w-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto text-xs"
            style={{ overflowAnchor: "auto" }}
          >
            {visible.map((run) => (
              <section key={run.id} className="border-b border-line pb-4 pt-2">
                <div className="flex min-w-0 items-baseline gap-2">
                  <strong className="shrink-0">Run {run.number}</strong>
                  <span className="truncate text-muted" title={run.promptPreview}>{run.promptPreview}</span>
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-muted">
                  <span className="min-w-0 truncate">{run.status === "finished" ? "Finished" : run.status} · {run.callCount} {run.callCount === 1 ? "call" : "calls"}{run.failedCalls ? ` · ${run.failedCalls} failed` : ""}</span>
                  <button className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline" onClick={async () => {
                    try { onJump(details[run.id] ?? await api<RunDetail>(`/api/runs/${encodeURIComponent(run.id)}`)); }
                    catch (reason) { setError(String(reason)); }
                  }}>Jump to message <ArrowUpRight className="size-3.5" /></button>
                </div>
                <div className="space-y-2">
                  {!run.detailsAvailable && (
                    <p>Recorded details are unavailable or expired.</p>
                  )}
                  {details[run.id] ? (
                    <RunContents
                      detail={details[run.id]}
                      loadImage={loadImage}
                      onOpenSkill={onOpenSkill}
                    />
                  ) : (
                    run.detailsAvailable && <p>Loading details…</p>
                  )}
                </div>
              </section>
            ))}
            {!visible.length &&
              !loading &&
              !["manual", "older"].includes(selectedRun) && (
                <p className="py-3 text-muted">
                  {selectedRun
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
  loadImage,
  onOpenSkill,
}: {
  detail: RunDetail;
  loadImage(id: string): Promise<Blob>;
  onOpenSkill(id: string): void;
}) {
  return (
    <>
      {detail.missingEvidence?.map((text) => (
        <p key={text} className="text-warn">
          {text}
        </p>
      ))}
      {!detail.calls.length && <p>No tools were called in this run.</p>}
      {detail.calls.map((call) => (
        <section key={call.id} className="border-t border-line py-3">
          <h3 className="mb-2 font-medium">
            {call.sequence}. {toolLabel(call.name)} · {call.status}
            {call.endedAt
              ? ` · ${Math.max(0, Date.parse(call.endedAt) - Date.parse(call.startedAt))} ms`
              : ""}
          </h3>
          <ToolCode argumentsValue={call.arguments} />
          <ExecutionResult result={callResult(call, detail.operations)} error={call.error} />
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
        </section>
      ))}
      <OperationList
        operations={detail.operations.filter(
          (operation) =>
            !detail.calls.some((call) =>
              call.operationIds.includes(operation.operationId),
            ),
        )}
      />
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

function callResult(call: RunDetail["calls"][number], operations: Operation[]): unknown {
  if (call.name !== "revit_execute_csharp") return call.result;
  const linked = operations.filter(operation => call.operationIds.includes(operation.operationId));
  if (linked.length) {
    const values = linked.map(operation => operation.error && operation.error !== call.error
      ? { error: operation.error, result: operation.result }
      : operation.result ?? { status: operation.status });
    return values.length === 1 ? values[0] : values;
  }
  // Native tool receipts duplicate the same response in content and details.
  const receipt = call.result as { content?: unknown[]; details?: unknown } | undefined;
  const value = receipt?.content && receipt.details !== undefined ? receipt.details : call.result;
  if (value && typeof value === "object" && ("operationId" in value || "transactionStatus" in value)) {
    const outcome = value as { result?: unknown; error?: string; status?: string };
    return outcome.error ? { error: outcome.error, result: outcome.result } : outcome.result ?? { status: outcome.status };
  }
  return value;
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
