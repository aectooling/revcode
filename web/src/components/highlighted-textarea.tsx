import { useRef, useState, type TextareaHTMLAttributes, type CSSProperties } from "react";
import { TokenLine, useCodeTokens } from "./highlighted-code";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & { value: string; onSubmit(): void };
const metrics: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: "22px", tabSize: 4, padding: 12, margin: 0, border: 0, letterSpacing: "normal", whiteSpace: "pre", overflowWrap: "normal" };

export function HighlightedTextarea({ value, onSubmit, className = "", onKeyDown, ...props }: Props) {
  const [composing, setComposing] = useState(false);
  const tokens = useCodeTokens(value, !composing, 120);
  const layer = useRef<HTMLPreElement>(null);
  return <div className="relative min-w-0 overflow-hidden rounded border border-line bg-surface focus-within:ring-2 focus-within:ring-accent/20">
    <pre ref={layer} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden" style={metrics}>
      {tokens && value.split(/\r\n|\n|\r/).map((line, index) => <span key={index}><TokenLine tokens={tokens[index]} fallback={line} />{"\n"}</span>)}
    </pre>
    <textarea {...props} value={value} spellCheck={false} wrap="off" className={`relative block w-full resize-y bg-transparent outline-none ${className}`}
      style={{ ...metrics, ...props.style, color: tokens ? "transparent" : undefined, caretColor: "var(--color-ink)" }}
      onScroll={event => { if (layer.current) { layer.current.scrollTop = event.currentTarget.scrollTop; layer.current.scrollLeft = event.currentTarget.scrollLeft; } props.onScroll?.(event); }}
      onCompositionStart={event => { setComposing(true); props.onCompositionStart?.(event); }}
      onCompositionEnd={event => { setComposing(false); props.onCompositionEnd?.(event); }}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !composing && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); onSubmit(); }
        onKeyDown?.(event);
      }} />
  </div>;
}
