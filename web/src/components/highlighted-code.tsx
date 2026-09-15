import { memo, useEffect, useRef, useState } from "react";
import type { ThemedToken } from "shiki";
import { Button } from "./ui/button";

export const isCsharp = (language: string) => /^(csharp|cs|c#)$/i.test(language);

export function useCodeTokens(code: string, enabled = true, delay = 0, language = "csharp") {
  const [result, setResult] = useState<{ code: string; language: string; tokens: ThemedToken[][] }>();
  useEffect(() => {
    // Keep very large sources readable without blocking the UI thread.
    if (!enabled || code.length > 100_000) return;
    let disposed = false;
    const timer = setTimeout(() => {
      void import("../lib/csharp-highlighter").then(module => module.highlightCsharp(code, language))
        .then(tokens => { if (!disposed) setResult({ code, language, tokens }); })
        .catch(() => { /* Plain source remains available. */ });
    }, delay);
    return () => { disposed = true; clearTimeout(timer); };
  }, [code, enabled, delay, language]);
  return result?.code === code && result.language === language && enabled ? result.tokens : undefined;
}

export function TokenLine({ tokens, fallback }: { tokens?: ThemedToken[]; fallback: string }) {
  return tokens ? tokens.map((token, index) => <span key={index} style={{ color: token.color }}>{token.content}</span>) : fallback;
}

export const HighlightedCode = memo(function HighlightedCode({ code, language = "csharp", label = "C# source", highlightLine }: {
  code: string; language?: string; label?: string; highlightLine?: number;
}) {
  const tokens = useCodeTokens(code, isCsharp(language) || language === "json", 0, isCsharp(language) ? "csharp" : language);
  const [wrap, setWrap] = useState(false);
  const [copyState, setCopyState] = useState("");
  const selectedLine = useRef<HTMLDivElement>(null);
  const lines = code.split(/\r\n|\n|\r/);
  useEffect(() => { selectedLine.current?.scrollIntoView({ block: "nearest" }); }, [highlightLine]);
  return <div className="my-2 min-w-0 overflow-hidden rounded border border-line bg-surface" aria-label={label}>
    <div className="flex items-center gap-2 border-b border-line p-1 text-xs">
      <span className="mr-auto truncate px-1">{label}</span>
      <Button size="sm" variant="ghost" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</Button>
      <Button size="sm" variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopyState("Copied"); } catch { setCopyState("Copy failed; select the source to copy."); } }}>Copy</Button>
      <span role="status">{copyState}</span>
    </div>
    {highlightLine !== undefined && (!Number.isInteger(highlightLine) || highlightLine < 1 || highlightLine > lines.length) && <p role="status" className="p-2 text-xs">Diagnostic line is outside the retained source.</p>}
    <div className="max-h-[420px] overflow-auto p-2 font-mono text-xs leading-5" style={{ tabSize: 4 }}>
      {lines.map((line, index) => <div key={index} ref={highlightLine === index + 1 ? selectedLine : undefined} className={`flex ${highlightLine === index + 1 ? "bg-accent-soft" : ""}`}>
        <span aria-hidden="true" className="mr-3 w-8 shrink-0 select-none text-right text-muted">{index + 1}</span>
        <code className="min-w-0 flex-1" style={{ padding: 0, background: "none", fontSize: "inherit", whiteSpace: wrap ? "pre-wrap" : "pre", overflowWrap: wrap ? "anywhere" : undefined }}><TokenLine tokens={tokens?.[index]} fallback={line} />{line === "" ? "\u200b" : ""}</code>
      </div>)}
    </div>
  </div>;
});
