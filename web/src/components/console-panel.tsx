import { Box, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { HighlightedTextarea } from "./highlighted-textarea";
import { Button } from "./ui/button";

export type Mode = "query" | "modify" | "api" | "batch";

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
  steps, onStepsChange, verify, onVerifyChange,
  code,
  onCodeChange,
  mode,
  onModeChange,
  documentToken,
  onDocumentTokenChange,
  documents,
  activeDocumentTitle,
  busy,
  pending,
  canRun,
  onRun,
  onCancel,
  docReadOnly, draftStatus, onClearDraft,
}: {
  steps: { name: string; code: string }[];
  onStepsChange(steps: { name: string; code: string }[]): void;
  verify: string;
  onVerifyChange(value: string): void;
  code: string;
  onCodeChange(value: string): void;
  mode: Mode;
  onModeChange(mode: Mode): void;
  documentToken: string;
  onDocumentTokenChange(token: string): void;
  documents: { token: string; title: string; isFamily: boolean }[];
  activeDocumentTitle?: string;
  busy: boolean;
  pending: boolean;
  canRun: boolean;
  onRun(): void;
  onCancel(): void;
  docReadOnly: boolean;
  draftStatus?: string;
  onClearDraft?(): void;
}): ReactNode {
  const runDisabled = !canRun || (mode === "batch" ? steps.some(s => !s.name.trim() || !s.code.trim()) : !code.trim()) || ((mode === "modify" || mode === "batch") && docReadOnly);
  return (
    <section aria-label="C# console" className="grid gap-1.5">
      <div className="flex items-center gap-2 text-xs"><span role="status">{draftStatus}</span>{onClearDraft && <Button size="sm" variant="ghost" onClick={onClearDraft}>Clear draft</Button>}</div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Snippet examples">
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
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="font-mono font-medium text-ink-soft">snippet.cs</span>
        <span className="truncate font-mono">object? Execute(RevcodeContext ctx)</span>
      </div>
      {mode === "batch" ? <div className="grid gap-2" aria-label="Batch steps">
        <p className="text-xs text-muted">All steps edit one target and commit together as one Undo entry. Verification must return true.</p>
        {steps.map((step, index) => <fieldset key={index} className="grid gap-1 rounded border border-line p-2">
          <legend>Step {index + 1}</legend>
          <input aria-label={`Step ${index + 1} name`} value={step.name} maxLength={100} className="bg-surface p-2"
            onChange={e => onStepsChange(steps.map((s, i) => i === index ? { ...s, name: e.target.value } : s))} />
          <HighlightedTextarea onSubmit={() => { if (!runDisabled) onRun(); }} aria-label={`Step ${index + 1} C#`} value={step.code} className="min-h-24 bg-surface p-2 font-mono text-xs"
            onChange={e => onStepsChange(steps.map((s, i) => i === index ? { ...s, code: e.target.value } : s))} />
          <Button variant="secondary" disabled={steps.length === 1} onClick={() => onStepsChange(steps.filter((_, i) => i !== index))}>Remove step</Button>
        </fieldset>)}
        <Button variant="secondary" disabled={steps.length >= 20} onClick={() => onStepsChange([...steps, { name: `Step ${steps.length + 1}`, code: "return null;" }])}>Add step</Button>
        <label className="grid gap-1 text-xs">Optional verification C#
          <HighlightedTextarea onSubmit={() => { if (!runDisabled) onRun(); }} aria-label="Batch verification" value={verify} onChange={e => onVerifyChange(e.target.value)} placeholder="return true;" className="min-h-20 bg-surface p-2 font-mono" />
        </label>
      </div> : <HighlightedTextarea
        id="code"
        aria-label="C# method body"
        spellCheck={false}
        value={code}
        onChange={(event) => onCodeChange(event.target.value)}
        onSubmit={() => { if (!runDisabled) onRun(); }}
        className="min-h-[220px] w-full resize-y rounded-md border border-line bg-surface p-3 font-mono text-[13px] leading-relaxed outline-none transition-colors hover:border-line-strong focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/15"
      />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="document-target" className="flex min-w-0 items-center gap-2 text-xs font-medium text-ink-soft">
          Target document
          <select
            id="document-target"
            value={documentToken}
            onChange={(event) => onDocumentTokenChange(event.target.value)}
            className="h-8 min-w-0 max-w-[280px] rounded-sm border border-line bg-surface px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <option value="">Active document · {activeDocumentTitle ?? "none"}</option>
            {documentToken && !documents.some(d => d.token === documentToken) && <option value={documentToken}>Closed document · select another</option>}
            {documents.map(d => <option key={d.token} value={d.token}>{d.title} · {d.isFamily ? "Family" : "Project"} · {d.token.slice(0, 8)}</option>)}
          </select>
        </label>
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
            <option value="batch">Batch · all steps or rollback</option>
            <option value="api">API · document operations</option>
          </select>
        </label>
        {busy ? (
          <Button variant="secondary" disabled={pending} onClick={onCancel} aria-label="Stop">
            <Loader2 className="size-3.5" />
            Stop
          </Button>
        ) : (
          <Button disabled={runDisabled} onClick={onRun}>
            Run C#
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Ctrl + Enter to run. Modify calls create a Revit Undo entry when committed.
        Stop is cooperative; running code must call{" "}
        <code className="rounded-[3px] bg-surface-muted px-1 py-0.5 font-mono text-[0.9em]">
          ctx.CheckCancellation()
        </code>
        .
      </p>
    </section>
  );
}
