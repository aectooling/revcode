import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LockKeyhole } from 'lucide-react';
import type { DesktopState } from '../../../src/host/desktop-types';
import { DesktopActivity } from './desktop-activity';
import { DesktopPreview } from './desktop-preview';
import { Button } from './ui/button';

export function DesktopPanel({ state, online, stop, loadImage }: {
  state?: DesktopState; online: boolean; stop(): Promise<void>; loadImage(artifact: string, signal: AbortSignal): Promise<Blob>;
}) {
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = ['preparing', 'recovering', 'controlling'].includes(state?.status ?? '');
  useEffect(() => {
    if (!active) { setError(''); setStopping(false); }
  }, [active]);
  useEffect(() => {
    if (!active || !state?.countdownEndsAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [active, state?.countdownEndsAt]);
  const seconds = Math.max(0, Math.ceil(((state?.countdownEndsAt ?? now) - now) / 1000));

  async function takeOver() {
    if (stopping) return;
    setStopping(true); setError('');
    try { await stop(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setStopping(false); }
  }

  return <Dialog.Root open={active}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[100] bg-white/65 backdrop-blur-2xl backdrop-saturate-150" />
      <Dialog.Content
        className="fixed inset-0 z-[101] overflow-y-auto p-4 outline-none sm:p-8"
        onEscapeKeyDown={event => event.preventDefault()}
        onPointerDownOutside={event => event.preventDefault()}
        onInteractOutside={event => event.preventDefault()}
      >
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center py-6">
        <div className="p-5 sm:p-8">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center">
            <LockKeyhole className="size-7 text-ink-soft" aria-hidden="true" />
          </div>
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.2em] text-muted">Revcode · Computer use</p>
          <Dialog.Title className="text-2xl font-semibold tracking-tight text-ink">{state?.status === 'preparing' ? 'Getting ready to work' : 'Revcode is working in Revit'}</Dialog.Title>
          <Dialog.Description className="mt-3 text-sm leading-relaxed text-ink-soft">Your session will be ready when the agent finishes. You can take back control at any time.</Dialog.Description>
          <p role="status" aria-live="polite" className="mt-4 text-sm text-ink-soft">{state?.status === 'preparing'
            ? seconds > 0 ? `Starting in ${seconds}s` : 'Preparing computer use…'
            : state?.status === 'recovering'
              ? seconds > 0 ? `Resuming in ${seconds}s` : 'Waiting to resume…'
              : 'Computer use in progress'}</p>
          <Button className="mt-4" variant="secondary" disabled={!online || stopping} onClick={() => void takeOver()}>{stopping ? 'Stopping…' : 'Stop and take control'}</Button>
          <p className="mt-4 text-xs text-muted">Or press Ctrl + Alt + F12 in Revit</p>
          {!online && <p role="alert" className="mt-4 text-sm text-warn">Connection lost. Use Ctrl + Alt + F12 to take control.</p>}
          {error && <p role="alert" className="mt-4 text-sm text-warn">{error}</p>}
        </div>
        <div className="mt-7 grid gap-6 border-t border-white/80 pt-6 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <DesktopPreview frame={state?.latest} loadImage={loadImage} />
          <DesktopActivity state={state} />
        </div>
        </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
