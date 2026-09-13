import { ChevronRight } from "lucide-react";
import { Badge } from "./ui/badge";

export type Operation = {
  operationId: string;
  code: string;
  mode: "query" | "modify" | "api";
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

function statusVariant(status: string) {
  if (status === "failed" || status === "unknown") return "danger" as const;
  if (["queued", "running", "compiling"].includes(status)) return "warn" as const;
  return "neutral" as const;
}

export function ExecutionHistory({ operations }: { operations: Operation[] }) {
  return (
    <aside
      aria-label="Execution history"
      className="max-h-[38dvh] w-full shrink-0 overflow-y-auto border-t border-line bg-panel px-3 py-3 lg:h-full lg:max-h-none lg:w-[320px] lg:border-t-0 lg:border-l"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">
          Execution history
        </h2>
        <Badge variant="neutral" className="shrink-0">
          {operations.length} operations
        </Badge>
      </div>
      {operations.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">
          Code, diagnostics, and transaction outcomes will appear here after execution.
        </p>
      ) : (
        <div className="mt-2 grid gap-1">
          {operations.map((operation) => {
            const open = !["succeeded", "cancelled"].includes(operation.status);
            return (
              <details
                className="operation group overflow-hidden rounded-[5px] border border-line bg-surface text-xs transition-colors hover:border-line-strong"
                key={operation.operationId}
                open={open}
              >
                <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 outline-none marker:content-none focus-visible:bg-surface-muted [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3 shrink-0 text-muted transition-transform group-open:rotate-90" />
                  <Badge variant={statusVariant(operation.status)}>
                    {operation.status === "queued" ? "Waiting for Revit" : operation.status}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-medium text-ink-soft">
                    {operation.mode === "modify" ? "Model change" : "Model query"}
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
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[3px] border border-line bg-surface px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-soft">
                    <code>{operation.code}</code>
                  </pre>
                  {operation.error && (
                    <p className="text-[11px] leading-relaxed text-danger">{operation.error}</p>
                  )}
                  {operation.diagnostics?.map((diagnostic, index) => (
                    <p key={index} className="text-[11px] leading-relaxed text-ink-soft">
                      <strong className="font-semibold">{diagnostic.severity}</strong>
                      {diagnostic.line
                        ? ` · line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}`
                        : ""}
                      : {diagnostic.message}
                    </p>
                  ))}
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
      )}
    </aside>
  );
}
