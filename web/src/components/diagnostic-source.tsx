import { HighlightedCode } from "./highlighted-code";

export function DiagnosticSource({ diagnostic, source }: {
  diagnostic: { severity: string; message: string; line?: number; column?: number; stepName?: string; stepIndex?: number };
  source: { code?: string; steps?: { name: string; code: string }[]; verify?: { code: string } };
}) {
  const { stepIndex, stepName } = diagnostic;
  // Native StepIndex is zero-based; verification follows the final batch step.
  const code = stepIndex !== undefined
    ? stepIndex === source.steps?.length ? source.verify?.code : source.steps?.[stepIndex]?.code
    : stepName ? source.steps?.find(step => step.name === stepName)?.code ?? (stepName === "verification" ? source.verify?.code : undefined) : source.code;
  return <div className="text-[11px] leading-relaxed text-ink-soft">
    <p><strong>{diagnostic.severity}</strong>{diagnostic.line ? ` · line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}` : ""}: {stepName ? `${stepName}: ` : ""}{diagnostic.message}</p>
    {diagnostic.line !== undefined && (code !== undefined
      ? <details><summary className="cursor-pointer text-accent">View historical source at line {diagnostic.line}</summary><HighlightedCode code={code} label={stepName ?? "Historical snippet"} highlightLine={diagnostic.line} /></details>
      : <p role="status">Diagnostic source is unavailable in retained history.</p>)}
  </div>;
}
