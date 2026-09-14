import type { DesktopState } from '../../../src/host/desktop-types';

const statuses = { running: 'In progress', captured: 'Captured', dispatched: 'Input sent', 'not-dispatched': 'Not sent', unknown: 'Unconfirmed', failed: 'Failed' };

export function DesktopActivity({ state, compact = false }: { state?: DesktopState; compact?: boolean }) {
  const events = state?.activity ?? [];
  return <section aria-label="Computer-use activity" className="min-w-0 text-left">
    <h3 className="text-xs font-medium text-ink">Computer-use activity</h3>
    {events.length === 0 ? <p className="mt-3 text-xs text-muted">{state?.status === 'preparing' ? 'Preparing to observe Revit…' : 'No computer-use activity yet.'}</p> :
      <ol role="log" aria-label="Desktop actions" aria-live="polite" className={`${compact ? 'max-h-52' : 'max-h-64'} mt-3 space-y-3 overflow-y-auto pr-1`}>
        {events.slice(compact ? -6 : -30).reverse().map(event => <li key={event.id} className="text-xs">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-words text-ink-soft">{event.label}</span>
            <time className="shrink-0 text-[10px] tabular-nums text-muted" dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
          </div>
          <p className={`mt-1 text-[10px] ${['failed', 'unknown', 'not-dispatched'].includes(event.status) ? 'text-warn' : 'text-muted'}`}>{statuses[event.status]}</p>
          {event.error && <p className="mt-1 break-words text-[11px] text-warn">{event.error}</p>}
        </li>)}
      </ol>}
    {state?.error && <p className="mt-3 break-words text-xs text-warn">{state.error}</p>}
  </section>;
}
