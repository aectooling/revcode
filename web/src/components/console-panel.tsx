import type { KeyboardEvent } from "react";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

type Mode = "query" | "modify";

type Example = { label: string; mode: Mode; code: string };

type ConsolePanelProps = {
  code: string;
  mode: Mode;
  examples: Example[];
  busy: boolean;
  pending: boolean;
  canExecute: boolean;
  readOnly?: boolean;
  onCodeChange(code: string): void;
  onModeChange(mode: Mode): void;
  onExample(example: Example): void;
  onRun(): void;
  onStop(): void;
};

export function ConsolePanel({
  code,
  mode,
  examples,
  busy,
  pending,
  canExecute,
  readOnly,
  onCodeChange,
  onModeChange,
  onExample,
  onRun,
  onStop,
}: ConsolePanelProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (code.trim()) onRun();
    }
  };

  return (
    <section
      aria-label="C# console"
      className="mx-auto w-full max-w-[760px] flex-1 overflow-y-auto px-4 py-4 sm:px-6"
    >
      <div className="animate-slide-up">
        <h2 className="text-[15px] font-semibold tracking-tight">
          Run a C# method body
        </h2>
        <p className="mt-1.5 max-w-[600px] text-[13px] leading-relaxed text-ink-soft">
          The same executor the assistant uses. No model or API key required.
          Access the current document through{" "}
          <code className="rounded-sm bg-surface-muted px-1 py-0.5 font-mono text-[12px]">
            ctx.Doc
          </code>
          .
        </p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {examples.map((example) => (
            <Button
              key={example.label}
              size="sm"
              variant="secondary"
              onClick={() => onExample(example)}
            >
              {example.label}
            </Button>
          ))}
        </div>
        <div className="mt-4 overflow-hidden rounded-md border border-line">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-muted px-3 py-2 text-[11px] text-muted">
            <label htmlFor="code">snippet.cs</label>
            <span className="font-mono">object? Execute(RevcodeContext ctx)</span>
          </div>
          <textarea
            className="block min-h-[290px] w-full resize-y border-0 bg-[#18181b] px-4 py-3 font-mono text-[12px] leading-7 text-[#e4e4e7] outline-none"
            id="code"
            spellCheck={false}
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-[200px]">
            <Label htmlFor="execution-mode">Execution mode</Label>
            <select
              id="execution-mode"
              aria-label="Execution mode"
              className="mt-1.5 flex h-8 w-full rounded-sm border border-line bg-surface px-2.5 text-[13px] outline-none transition-colors hover:border-line-strong focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/15"
              value={mode}
              onChange={(event) => onModeChange(event.target.value as Mode)}
            >
              <option value="query">Query · no transaction</option>
              <option value="modify">Modify · one transaction</option>
            </select>
          </div>
          {busy ? (
            <Button variant="destructive" disabled={pending} onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button
              disabled={!canExecute || !code.trim() || (mode === "modify" && readOnly)}
              onClick={onRun}
            >
              Run C#
            </Button>
          )}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          Ctrl + Enter to run. Modify calls create a Revit Undo entry when committed.
          Stop is cooperative; running code must call{" "}
          <code className="rounded-sm bg-surface-muted px-1 py-0.5 font-mono text-[11px]">
            ctx.CheckCancellation()
          </code>
          .
        </p>
      </div>
    </section>
  );
}
