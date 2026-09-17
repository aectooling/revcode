import { ArrowUp, Square, Paperclip, Pencil, Camera, X } from "lucide-react";
import { IMAGE_ACCEPT, imageUrl, readImage, type DraftImage } from "../lib/image-attachments";
import { MAX_IMAGES } from "../../../src/host/images";
import { ImageAnnotationDialog } from "./image-annotation-dialog";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "./ui/button";

const MAX_HEIGHT = 220;

export type ComposerHandle = { focus(): void };

export type ComposerProps = {
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  /** Blocks editing entirely, e.g. while the local host is unreachable. */
  disabled: boolean;
  /** Blocks sending while keeping the draft editable, e.g. before a provider is connected. */
  submitDisabled: boolean;
  /** Explains why sending is blocked. Shown above the text field. */
  alert?: ReactNode;
  canAbort: boolean;
  abortDisabled?: boolean;
  onAbort(): void;
  /** Toolbar controls rendered at the start of the bottom row (model, document target). */
  controls?: ReactNode;
  placeholder?: string;
  images: DraftImage[];
  onImagesChange(images: DraftImage[]): void;
  onCapture(): Promise<DraftImage>;
  captureDisabled: boolean;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    draft,
    onDraftChange,
    onSubmit,
    disabled,
    submitDisabled,
    alert,
    canAbort,
    abortDisabled = false,
    onAbort,
    controls,
    placeholder,
    images,
    onImagesChange,
    onCapture,
    captureDisabled,
  },
  ref,
) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ attachment?: DraftImage } | null>(null);
  const locked = disabled || processing;
  const addFiles = async (files: File[]) => {
    if (disabled || processingRef.current || !files.length) return;
    if (files.length + images.length > MAX_IMAGES) { setError(`Attach up to ${MAX_IMAGES} images.`); return; }
    processingRef.current = true; setProcessing(true); setError("");
    try { onImagesChange([...images, ...await Promise.all(files.map(readImage))]); }
    catch (reason) { setError((reason as Error).message); }
    finally { processingRef.current = false; setProcessing(false); }
  };
  const capture = async () => {
    if (locked || processingRef.current || captureDisabled || images.length >= MAX_IMAGES) return;
    processingRef.current = true; setProcessing(true); setError("");
    try { onImagesChange([...images, await onCapture()]); }
    catch (reason) { setError((reason as Error).message); }
    finally { processingRef.current = false; setProcessing(false); }
  };
  const expanded = focused || draft.length > 0;
  useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);

  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = expanded
      ? `${Math.max(88, Math.min(node.scrollHeight, MAX_HEIGHT))}px`
      : "40px";
    node.style.overflowY = expanded && node.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [draft, expanded]);

  const canSend = !locked && !editor && !submitDisabled && (draft.trim().length > 0 || images.length > 0);
  const showStop = canAbort && !canSend;

  const submit = (event?: React.FormEvent) => {
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

  return (
    <footer className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
      <form
        onSubmit={submit}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)); }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
          if (files.length) { event.preventDefault(); void addFiles(files); }
        }}
        className="relative mx-auto w-full max-w-[760px] rounded-md border border-line bg-surface transition-colors focus-within:border-accent/60"
      >
        <input ref={picker} type="file" accept={IMAGE_ACCEPT} multiple hidden aria-label="Choose images"
          onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        {images.length > 0 && <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Image attachments">
          {images.map(attachment => <div key={attachment.id} className="relative rounded border border-line p-1">
            <button type="button" disabled={locked} title="Draw on image" aria-label={`Annotate ${attachment.name}`}
              onClick={() => setEditor({ attachment })}>
              <img src={imageUrl(attachment.image)} alt={attachment.name} className="h-20 w-24 rounded object-contain" />
            </button>
            <button type="button" className="absolute -right-1 -top-1 rounded-full border border-line bg-surface p-0.5"
              disabled={locked} aria-label={`Remove ${attachment.name}`} onClick={() => onImagesChange(images.filter(image => image.id !== attachment.id))}><X className="size-3" /></button>
          </div>)}
          <span className="self-end text-xs text-muted">Click an image to draw on it.</span>
        </div>}
        {error && <p role="alert" className="px-3 pt-2 text-xs text-danger">{error}</p>}
        {processing && <p role="status" className="px-3 pt-2 text-xs text-muted">Preparing image…</p>}
        {alert && (
          <p role="status" className="px-3 pt-2 text-xs text-muted [&_button]:text-accent-hover [&_button]:underline [&_button]:underline-offset-2">
            {alert}
          </p>
        )}
        <label className="sr-only" htmlFor="prompt">
          Message the assistant
        </label>
        <textarea
          id="prompt"
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
          placeholder={
            disabled ? placeholder ?? "Waiting for the Revcode host…" : "Describe a change, or ask about your model…"
          }
          className="block min-h-[40px] max-h-[220px] w-full resize-none bg-transparent pb-1 pl-3.5 pr-11 pt-3 text-[14px] leading-6 outline-none placeholder:text-muted aria-disabled:cursor-not-allowed"
        />
        <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5 pr-11 pt-0.5">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Attach images" title="Attach images (or paste / drop)" disabled={locked || images.length >= MAX_IMAGES} onClick={() => picker.current?.click()}><Paperclip className="size-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="New drawing" title="Draw on a blank canvas" disabled={locked || images.length >= MAX_IMAGES} onClick={() => setEditor({})}><Pencil className="size-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Capture active view" title="Attach a screenshot of the active Revit view" disabled={locked || captureDisabled || images.length >= MAX_IMAGES} onClick={() => void capture()}><Camera className="size-4" /></Button>
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
          {showStop ? <Square className="size-3 fill-current" /> : <ArrowUp className="size-4" />}
        </Button>
      </form>
      {editor && <ImageAnnotationDialog attachment={editor.attachment} onClose={() => setEditor(null)} onSave={image => {
        onImagesChange(editor.attachment ? images.map(item => item.id === image.id ? image : item) : [...images, image]);
        setEditor(null);
      }} />}
    </footer>
  );
});
