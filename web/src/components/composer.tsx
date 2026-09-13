import { ArrowUp, Square } from "lucide-react";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "./ui/button";

const MAX_HEIGHT = 220;

export type ComposerHandle = { focus(): void };

export type ComposerProps = {
  draft: string;
  onDraftChange(value: string): void;
  disabled: boolean;
  submitDisabled?: boolean;
  streaming: boolean;
  abortDisabled?: boolean;
  onSubmit(): void;
  onAbort(): void;
  controls?: ReactNode;
  hint?: ReactNode;
  placeholder?: string;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    draft,
    onDraftChange,
    disabled,
    submitDisabled,
    streaming,
    abortDisabled = false,
    onSubmit,
    onAbort,
    controls,
    hint,
    placeholder,
  },
  ref,
) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const expanded = focused;

  useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);

  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = expanded
      ? `${Math.max(88, Math.min(node.scrollHeight, MAX_HEIGHT))}px`
      : "40px";
    node.style.overflowY =
      expanded && node.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [draft, expanded]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSubmit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const canSend = !disabled && !submitDisabled && draft.trim().length > 0;
  const showStop = streaming && !canSend;

  return (
    <footer className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
      {hint}
      <form
        onSubmit={submit}
        className="relative mx-auto w-full max-w-[760px] rounded-md border border-line bg-surface transition-colors focus-within:border-accent/60"
      >
        <label className="sr-only" htmlFor="composer-input">
          Message the assistant
        </label>
        <textarea
          id="composer-input"
          ref={textarea}
          rows={1}
          value={draft}
          readOnly={disabled}
          aria-disabled={disabled}
          autoComplete="off"
          onChange={(event) => onDraftChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? "Describe a change, or ask about your model…"}
          className="block min-h-[40px] max-h-[220px] w-full resize-none bg-transparent pb-1 pl-3.5 pr-11 pt-3 text-[14px] leading-6 outline-none placeholder:text-muted aria-disabled:cursor-not-allowed"
        />
        <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5 pr-11 pt-0.5">
          {controls}
        </div>
        <Button
          className="absolute bottom-1.5 right-1.5 shadow-sm"
          type={showStop ? "button" : "submit"}
          size="icon-sm"
          disabled={showStop ? abortDisabled : !canSend}
          onClick={showStop ? onAbort : undefined}
          aria-label={showStop ? "Stop" : "Send"}
          title={showStop ? "Stop" : "Send (Enter)"}
        >
          {showStop ? (
            <Square className="size-3 fill-current" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </Button>
      </form>
      <p className="mx-auto mt-2 max-w-[760px] text-center text-[10px] text-muted">
        Enter to send · Shift + Enter for a new line
      </p>
    </footer>
  );
});
