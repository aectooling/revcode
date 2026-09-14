import { useEffect, useState } from 'react';
import type { DesktopState } from '../../../src/host/desktop-types';
import { Button } from './ui/button';

export function DesktopPanel({ state, online, vision, capture, stop, loadImage }: {
  state?: DesktopState; online: boolean; vision: boolean;
  capture(): Promise<void>; stop(): Promise<void>; loadImage(artifact: string, signal: AbortSignal): Promise<Blob>;
}) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = ['preparing', 'recovering', 'controlling'].includes(state?.status ?? '');
  useEffect(() => {
    if (!state?.countdownEndsAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [state?.countdownEndsAt]);
  const seconds = Math.max(0, Math.ceil(((state?.countdownEndsAt ?? now) - now) / 1000));
  const artifact = state?.latest?.artifact;
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setImage('');
    if (artifact) void loadImage(artifact, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setImage(url);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [artifact, loadImage]);

  async function observe() {
    setCapturing(true); setError('');
    try { await capture(); } catch (reason) { setError((reason as Error).message); }
    finally { setCapturing(false); }
  }

  return <section aria-label="Revit desktop control" className="shrink-0 border-b border-line px-4 py-2 text-xs">
    {active && <div role="status" aria-live="polite" className="mb-2 rounded-lg border border-warn bg-surface px-3 py-2 text-sm">
      <strong>{state?.status === 'preparing'
        ? seconds > 0 ? `Desktop control starts in ${seconds}s` : 'Preparing desktop control…'
        : state?.status === 'recovering'
          ? seconds > 0 ? `Input detected — retrying in ${seconds}s` : 'Waiting for the mouse and keyboard to be released…'
          : 'Agent is using your mouse and keyboard'}</strong>
      <p>Please leave the mouse and keyboard alone until control finishes. Use Stop desktop or Ctrl+Alt+F12 to take over.</p>
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      <strong>Desktop: {state?.status ?? 'unavailable'}</strong>
      <Button size="sm" variant="secondary" disabled={!online || !state?.available || capturing || active} onClick={() => void observe()}>
        {capturing ? 'Capturing…' : 'Screenshot'}
      </Button>
      <Button size="sm" variant="secondary" disabled={!online} onClick={() => void stop().catch(reason => setError(reason.message))}>Stop desktop</Button>
      <span className="text-ink-soft">Ctrl+Alt+F12 stops input in Revit.</span>
    </div>
    <p className="mt-1 text-ink-soft">Experimental. Agent screenshots are sent to your selected model. {vision ? 'Desktop tools are available to this vision model.' : 'Select an image-capable model for agent desktop actions.'}</p>
    {(error || state?.error) && <p role="alert" className="mt-1 text-warn">{error || state?.error}</p>}
    {state?.latest && <details className="mt-1">
      <summary className="cursor-pointer">Latest screenshot: {state.latest.title} · {new Date(state.latest.timestamp).toLocaleTimeString()}</summary>
      {image && <img src={image} alt={`Revit desktop: ${state.latest.title}`} className="mt-2 max-h-80 max-w-full object-contain" />}
      <p className="text-ink-soft">{state.latest.width} × {state.latest.height}. Screenshots do not confirm an action succeeded.</p>
      {state.operations.slice(-5).map(operation => <p key={operation.operationId}>{operation.input.action}: {operation.receipt.status}{operation.receipt.error ? ` — ${operation.receipt.error}` : ''}</p>)}
    </details>}
  </section>;
}
