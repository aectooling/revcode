import { ArrowDown, Loader2 } from "lucide-react";
import { useEffect, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "../../../src/host/types";
import { MessageMarkdown } from "./message-markdown";
import { Button } from "./ui/button";
import { RunActivity } from "./run-activity";
import type { RunSummary } from "../../../src/host/history-types";
const SUGGESTIONS = [
  "List the levels and their elevations.",
  "Tell me about the selected elements.",
];
function AttachedImage({ image, index, load }: { image: NonNullable<Message["images"]>[number]; index: number; load(id: string): Promise<Blob> }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true, objectUrl: string | undefined;
    setUrl(undefined); setFailed(false);
    if (image.artifact) void load(image.artifact).then(blob => {
      if (active) { objectUrl = URL.createObjectURL(new Blob([blob], { type: image.mimeType ?? blob.type })); setUrl(objectUrl); }
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [image.artifact, image.mimeType, load]);
  if (image.unavailable || failed) return <p className="text-xs text-muted">{image.unavailable ?? "Attached image unavailable or expired."}</p>;
  return url ? <img src={url} alt={`Attached image ${index + 1}`} className="mb-2 max-h-80 max-w-full rounded object-contain" /> : <span role="status">Loading attached image…</span>;
}

function UserBubble({ text, images, loadImage }: Pick<Message, "text" | "images"> & { loadImage(id: string): Promise<Blob> }) {
  return (
    <div
      className="flex justify-end animate-slide-up"
      aria-label="Your message"
    >
      <div className="min-w-0 max-w-[min(85%,560px)]">
        <div className="whitespace-pre-wrap break-words rounded-md bg-surface-muted px-3.5 py-2 text-[14px] leading-6 text-ink">
          {images?.map((image, index) => <AttachedImage key={index} image={image} index={index} load={loadImage} />)}
          {text}
        </div>
      </div>
    </div>
  );
}

export function Welcome({
  connected,
  configured,
  onSuggestion,
}: {
  connected: boolean;
  configured: boolean;
  onSuggestion(prompt: string): void;
}) {
  return (
    <section
      className="mx-auto mt-[max(14vh,2rem)] w-full max-w-[560px] animate-slide-up"
      aria-labelledby="welcome-title"
    >
      <h2
        id="welcome-title"
        className="text-[22px] font-semibold leading-tight tracking-[-.02em]"
      >
        <span className="text-accent-hover">Rev</span>code
      </h2>
      <p className="mt-1.5 text-[13px] text-muted">
        {!connected
          ? "Connecting to the local Revcode host…"
          : configured
            ? "Describe a change, or ask about your model. Every C# operation appears in the execution history."
            : "Connect a model provider to start working with your Revit model."}
      </p>
      <div
        className="mt-5 flex flex-wrap gap-1.5"
        role="group"
        aria-label="Prompt suggestions"
      >
        {SUGGESTIONS.map((text) => (
          <Button
            key={text}
            size="sm"
            variant="secondary"
            disabled={!connected || !configured}
            onClick={() => onSuggestion(text)}
          >
            {text}
          </Button>
        ))}
      </div>
    </section>
  );
}

export function Conversation({
  messages,
  runs,
  api,
  busy,
  connected,
  configured,
  onSuggestion,
  onViewTools,
  loadImage,
  jumpMessageId,
}: {
  messages: Message[];
  runs: RunSummary[];
  api<T>(path: string): Promise<T>;
  loadImage(id: string): Promise<Blob>;
  onViewTools?(runId: string): void;
  jumpMessageId?: string;
  busy: boolean;
  connected: boolean;
  configured: boolean;
  onSuggestion(prompt: string): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => {
    const node = scroller.current;
    if (!node) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    node.scrollTo({
      top: node.scrollHeight,
      behavior: reducedMotion ? "auto" : behavior,
    });
  };
  const onScroll = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distance < 120;
    setShowJump(distance > 240);
  }, []);
  useLayoutEffect(() => {
    if (stickToBottom.current) scrollToLatest("auto");
  }, [messages.length, messages.at(-1)?.text]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!jumpMessageId) return;
    stickToBottom.current = false;
    document
      .getElementById(`message-${jumpMessageId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [jumpMessageId, messages.length]);
  const last = messages.at(-1);
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-4 py-6 sm:px-6"
        aria-label="Conversation"
        aria-live="polite"
        role="log"
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 pb-4">
          {messages.length === 0 ? (
            <Welcome
              connected={connected}
              configured={configured}
              onSuggestion={onSuggestion}
            />
          ) : (
            messages.map((message) => {
              if (message.role === "user")
                return (
                  <div key={message.id} id={`message-${message.id}`}>
                    <UserBubble text={message.text} images={message.images} loadImage={loadImage} />
                  </div>
                );
              if (message.role === "system")
                return (
                  <p
                    key={message.id}
                    role="status"
                    className="text-[13px] text-muted"
                  >
                    {message.text}
                  </p>
                );
              const streaming = busy && message === last;
              const reply = (
                <>
                  {message.text ? (
                    <div className="min-w-0 text-[14px] leading-7 text-ink">
                      <MessageMarkdown text={message.text} />
                      {streaming && (
                        <span
                          aria-hidden="true"
                          className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[3px] bg-accent animate-blink"
                        />
                      )}
                    </div>
                  ) : streaming ? (
                    <p
                      role="status"
                      className="flex items-center gap-2 text-[13px] text-muted"
                    >
                      <Loader2 className="size-3.5 animate-spin" />
                      Working…
                    </p>
                  ) : (
                    <p className="text-[14px] text-muted">…</p>
                  )}
                </>
              );
              return (
                <div key={message.id} id={`message-${message.id}`} className="min-w-0 animate-slide-up" aria-label="Revcode's reply">
                  {message.runId ? (
                    <RunActivity runId={message.runId} summary={runs.find(run => run.id === message.runId)} busy={streaming} connected={connected} api={api} onViewTools={onViewTools}>
                      {reply}
                    </RunActivity>
                  ) : reply}
                </div>
              );
            })
          )}
        </div>
      </div>
      {showJump && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-pop animate-pop-in"
          // Keep the composer from collapsing and moving this button before pointer-up.
          onPointerDown={(event) => {
            if (event.button === 0) event.preventDefault();
          }}
          onClick={() => {
            stickToBottom.current = true;
            scrollToLatest();
          }}
        >
          <ArrowDown className="size-3.5" />
          Jump to latest
        </Button>
      )}
    </div>
  );
}
