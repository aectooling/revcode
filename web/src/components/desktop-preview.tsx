import { useEffect, useState } from 'react';
import { MousePointer2 } from 'lucide-react';
import type { DesktopEvidence } from '../../../src/host/desktop-types';

export function DesktopPreview({ frame, loadImage }: { frame?: DesktopEvidence; loadImage(artifact: string, signal: AbortSignal): Promise<Blob> }) {
  const [image, setImage] = useState<{ artifact: string; url: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setImage(undefined); setError('');
    if (frame) void loadImage(frame.artifact, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setImage({ artifact: frame.artifact, url });
    }).catch(() => { if (!controller.signal.aborted) setError('Preview unavailable. Waiting for the next screenshot.'); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [frame?.artifact, loadImage]);
  const cursor = frame?.cursor;
  const visibleCursor = frame && cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) && cursor.x >= 0 && cursor.y >= 0 && cursor.x < frame.width && cursor.y < frame.height;
  return <section aria-label="Agent desktop preview" className="min-w-0">
    <div className="mb-3 flex items-center justify-between gap-3 text-xs">
      <h3 className="font-medium">Agent’s view</h3>
      <span className="text-muted">Latest screenshot · not live video</span>
    </div>
    <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-xl border border-white/80 bg-ink/[.04]">
      {frame && image?.artifact === frame.artifact ? <div className="relative inline-block max-w-full leading-none">
        <img src={image.url} alt={`Revit desktop: ${frame.title}`} className="max-h-[42dvh] max-w-full object-contain" />
        {visibleCursor && <span role="img" aria-label={`Cursor at capture: ${Math.round(cursor.x)}, ${Math.round(cursor.y)}`} className="pointer-events-none absolute" style={{ left: `${cursor.x / frame.width * 100}%`, top: `${cursor.y / frame.height * 100}%` }}>
          <span className="absolute -left-3 -top-3 size-6 rounded-full border-2 border-accent bg-accent/20" />
          <MousePointer2 className="relative size-5 fill-accent text-white drop-shadow" />
        </span>}
      </div> : <p className="px-6 text-center text-xs text-muted">{error || (frame ? 'Loading screenshot…' : 'Waiting for the first screenshot…')}</p>}
    </div>
    {frame && <p className="mt-2 truncate text-[11px] text-muted" title={frame.title}>{frame.title} · {new Date(frame.timestamp).toLocaleTimeString()} · {visibleCursor ? 'Blue marker: cursor at capture' : 'Cursor position unavailable'}</p>}
  </section>;
}
