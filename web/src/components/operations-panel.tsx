import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { cn } from "../lib/utils";

type Operation = {
  operationId: string;
  code: string;
  mode: "query" | "modify";
  status: string;
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

export function OperationsPanel({ operations }: { operations: Operation[] }) {
  return (
    <section
      aria-label="Execution history"
      className="shrink-0 border-t border-line bg-panel px-4 py-3 sm:px-6"
    >
      <div className="mx-auto flex max-w-[760px] items-center justify-between gap-3">
        <h2 className="text-xs font-semibold tracking-tight">Execution history</h2>
        <span className="text-[11px] text-muted">{operations.length} operations</span>
      </div>
      {operations.length === 0 ? (
        <p className="mx-auto mt-2 max-w-[760px] text-[11px] text-muted">
          Code, diagnostics, and transaction outcomes will appear here after execution.
        </p>
      ) : (
        <div className="mx-auto mt-2 grid max-w-[760px] gap-1.5">
          {operations.map((operation) => {
            const open =
              operation.status === "failed" ||
              operation.status === "unknown" ||
              !["succeeded", "cancelled"].includes(operation.status);
            return (
              <Collapsible
                key={operation.operationId}
                defaultOpen={open}
                className="operation overflow-hidden rounded-md border border-line bg-surface text-xs"
              >
                <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted">
                  <ChevronRight className="size-3 shrink-0 text-muted transition-transform group-data-[state=open]:rotate-90" />
                  <span
                    className={cn(
                      "rounded-sm px-1.5 py-0.5 text-[10px] font-medium capitalize",
                      operation.status === "succeeded" &&
                        "bg-accent-soft text-accent",
                      (operation.status === "failed" ||
                        operation.status === "unknown") &&
                        "bg-danger-soft text-danger",
                      !["succeeded", "failed", "unknown"].includes(
                        operation.status,
                      ) && "bg-surface-muted text-ink-soft",
                    )}
                  >
                    {operation.status === "queued"
                      ? "Waiting for Revit"
                      : operation.status}
                  </span>
                  <span className="text-[11px]">
                    {operation.mode === "modify" ? "Model change" : "Model query"}
                  </span>
                  <span className="ml-auto text-[10px] text-muted">
                    {operation.elapsedMs !== undefined
                      ? `${(operation.elapsedMs / 1000).toFixed(2)}s`
                      : ""}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t border-line bg-surface-muted">
                  <div className="space-y-3 px-3 py-2.5">
                    <p className="break-all text-[10px] text-muted">
                      {operation.operationId}
                      {operation.transactionStatus
                        ? ` · Transaction: ${operation.transactionStatus}`
                        : ""}
                    </p>
                    <pre className="max-h-[350px] overflow-auto rounded-sm border border-line bg-[#18181b] p-3 font-mono text-[11px] leading-relaxed text-[#e4e4e7]">
                      <code>{operation.code}</code>
                    </pre>
                    {operation.error && (
                      <p className="text-[12px] text-danger">{operation.error}</p>
                    )}
                    {operation.diagnostics?.map((diagnostic, index) => (
                      <p key={index} className="text-[12px] text-danger">
                        <strong>{diagnostic.severity}</strong>
                        {diagnostic.line
                          ? ` · line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}`
                          : ""}
                        : {diagnostic.message}
                      </p>
                    ))}
                    {!!operation.logs?.length && (
                      <>
                        <p className="text-[11px] font-medium">Logs</p>
                        <pre className="overflow-auto rounded-sm border border-line bg-surface p-2 font-mono text-[11px]">
                          {operation.logs.join("\n")}
                        </pre>
                      </>
                    )}
                    {operation.result !== undefined && (
                      <>
                        <p className="text-[11px] font-medium">Result</p>
                        <pre className="max-h-[350px] overflow-auto rounded-sm border border-line bg-surface p-2 font-mono text-[11px]">
                          {JSON.stringify(operation.result, null, 2)}
                        </pre>
                      </>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}
    </section>
  );
}
