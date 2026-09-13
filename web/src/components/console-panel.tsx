import { Box, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";

export type Mode = "query" | "modify";

export const examples: { label: string; mode: Mode; code: string }[] = [
  {
    label: "Query levels",
    mode: "query",
    code: `return new FilteredElementCollector(ctx.Doc)
    .OfClass(typeof(Level))
    .Cast<Level>()
    .Select(level => new {
        id = level.UniqueId,
        name = level.Name,
        elevationMm = UnitUtils.ConvertFromInternalUnits(
            level.Elevation, UnitTypeId.Millimeters)
    })
    .ToArray();`,
  },
  {
    label: "Create level",
    mode: "modify",
    code: `ctx.CheckCancellation();
var elevation = UnitUtils.ConvertToInternalUnits(3000, UnitTypeId.Millimeters);
var level = Level.Create(ctx.Doc, elevation);
ctx.Log("Created level at 3000 mm.");
return new { id = level.UniqueId, name = level.Name };`,
  },
  {
    label: "Test rollback",
    mode: "modify",
    code: `var elevation = UnitUtils.ConvertToInternalUnits(4500, UnitTypeId.Millimeters);
var level = Level.Create(ctx.Doc, elevation);
ctx.Log("Created a temporary level; the exception should roll it back.");
throw new InvalidOperationException("Intentional rollback test. No level should remain.");`,
  },
];

export function DocumentTarget({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-7 max-w-[200px] shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-ink-soft"
      title={`Messages run against: ${label}`}
    >
      <Box className="size-3.5 shrink-0 text-muted" />
      <span className="block truncate" aria-label="Message destination">
        {label}
      </span>
    </span>
  );
}

export function ConsolePanel({
  code,
  onCodeChange,
  mode,
  onModeChange,
  busy,
  pending,
  canRun,
  onRun,
  onCancel,
  docReadOnly,
}: {
  code: string;
  onCodeChange(value: string): void;
  mode: Mode;
  onModeChange(mode: Mode): void;
  busy: boolean;
  pending: boolean;
  canRun: boolean;
  onRun(): void;
  onCancel(): void;
  docReadOnly: boolean;
}): ReactNode {
  return (
    <section aria-label="C# console" className="mx-auto w-full max-w-[760px] flex-1 overflow-y-auto px-4 py-6 sm:px-6">
      <div className="animate-slide-up">
        <div className="grid gap-1">
          <h2 className="text-[15px] font-semibold tracking-tight">Run a C# method body</h2>
          <p className="text-[13px] leading-relaxed text-ink-soft">
            The same executor the assistant uses. No model or API key required. Access
            the current document through <code className="rounded-[3px] bg-surface-muted px-1 py-0.5 font-mono text-[0.9em]">ctx.Doc</code>.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Snippet examples">
          {examples.map((example) => (
            <Button
              key={example.label}
              size="sm"
              variant="secondary"
              onClick={() => {
                onCodeChange(example.code);
                onModeChange(example.mode);
              }}
            >
              {example.label}
            </Button>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 text-[11px] text-muted">
          <span className="font-mono font-medium text-ink-soft">snippet.cs</span>
          <span className="truncate font-mono">object? Execute(RevcodeContext ctx)</span>
        </div>
        <textarea
          id="code"
          spellCheck={false}
          value={code}
          onChange={(event) => onCodeChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              if (code.trim() && canRun) onRun();
            }
          }}
          className="mt-1 min-h-[240px] w-full resize-y rounded-md border border-line bg-surface p-3 font-mono text-[13px] leading-relaxed outline-none transition-colors hover:border-line-strong focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/15"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="mode" className="flex items-center gap-2 text-xs font-medium text-ink-soft">
            Execution mode
            <select
              id="mode"
              value={mode}
              onChange={(event) => onModeChange(event.target.value as Mode)}
              className="h-8 rounded-sm border border-line bg-surface px-2 text-[13px] outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="query">Query · no transaction</option>
              <option value="modify">Modify · one transaction</option>
            </select>
          </label>
          {busy ? (
            <Button variant="secondary" disabled={pending} onClick={onCancel} aria-label="Stop">
              <Loader2 className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button disabled={!canRun || !code.trim() || (mode === "modify" && docReadOnly)} onClick={onRun}>
              Run C#
            </Button>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Ctrl + Enter to run. Modify calls create a Revit Undo entry when committed.
          Stop is cooperative; running code must call{" "}
          <code className="rounded-[3px] bg-surface-muted px-1 py-0.5 font-mono text-[0.9em]">
            ctx.CheckCancellation()
          </code>
          .
        </p>
      </div>
    </section>
  );
}
