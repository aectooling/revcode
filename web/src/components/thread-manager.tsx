import { Copy } from "lucide-react";
import { useState } from "react";
import type { ThreadSummary } from "../../../src/host/types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export function ThreadManager({ target, threads, protectedIds, storage, online, onClose, onDelete }: {
  target?: ThreadSummary;
  threads: ThreadSummary[];
  protectedIds: string[];
  storage?: { journalPath: string; runsPath: string };
  online: boolean;
  onClose(): void;
  onDelete(ids: string[], before?: number | null): Promise<void>;
}) {
  const [period, setPeriod] = useState("year");
  const [now] = useState(Date.now);
  const [review, setReview] = useState<{ ids: string[]; before?: number | null } | undefined>(target ? { ids: [target.id] } : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const date = new Date(now);
  if (period === "week") date.setDate(date.getDate() - 7);
  else {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() - (period === "year" ? 12 : 1));
    date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  }
  const before = period === "all" ? null : +date;
  const eligible = threads.filter(thread => thread.archivedAt && !protectedIds.includes(thread.id) && (before === null || Date.parse(thread.updatedAt) < before)).slice(0, 500);
  const count = review?.ids.length ?? eligible.length;
  async function remove() {
    if (!review) { setReview({ ids: eligible.map(thread => thread.id), before }); return; }
    setBusy(true); setError("");
    try { await onDelete(review.ids, review.before); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{target ? `Delete '${target.title}'?` : review ? "Delete archived threads?" : "Manage archived threads"}</DialogTitle>
        <DialogDescription>{review ? `Permanently delete ${count} ${count === 1 ? "thread" : "threads"}, including saved messages, tool logs and attached images. This cannot be undone. Revit model changes and saved skills are not undone.` : "View where conversations are saved and remove archived threads you no longer need."}</DialogDescription>
      </DialogHeader>
      {!review && <>
        <div className="grid gap-2 rounded-md border border-line bg-panel p-3">
          <p className="text-xs font-medium">Saved on this host</p>
          {storage ? Object.entries({ "Thread history": storage.journalPath, "Run logs and images": storage.runsPath }).map(([label, path]) => <div key={label} className="flex items-start gap-2">
            <div className="min-w-0 flex-1"><p className="text-[11px] text-muted">{label}</p><code className="select-text break-all text-xs">{path}</code></div>
            <Button size="icon-sm" variant="ghost" aria-label={`Copy ${label.toLowerCase()} path`} onClick={() => { void navigator.clipboard.writeText(path).then(() => setCopied("Path copied"), () => setCopied("Couldn't copy. Select the path and copy it manually.")); }}><Copy className="size-3.5" /></Button>
          </div>) : <p className="text-xs text-muted">Saved location unavailable.</p>}
          {copied && <p role="status" className="text-xs text-muted">{copied}</p>}
        </div>
        <label className="grid gap-1.5 text-xs font-medium">Delete archived threads
          <select aria-label="Delete archived threads" value={period} onChange={event => setPeriod(event.target.value)} className="rounded-md border border-line-strong bg-surface px-3 py-2 text-sm">
            <option value="week">Older than 1 week</option><option value="month">Older than 1 month</option><option value="year">Older than 1 year</option><option value="all">All archived threads</option>
          </select>
        </label>
        <p role="status" className="text-sm">{count ? `${count} archived ${count === 1 ? "thread matches" : "threads match"}.` : "No archived threads match this period."}</p>
        <p className="text-xs text-muted">Based on last activity{before === null ? "." : ` before ${new Date(before).toLocaleString()}.`} Threads still working or needing recovery are excluded.</p>
      </>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => { if (review && !target) { setReview(undefined); setError(""); } else onClose(); }}>{review && !target ? "Back" : "Cancel"}</Button>
        <Button variant="destructive" disabled={!online || busy || !count || !!review?.ids.some(id => protectedIds.includes(id))} onClick={() => void remove()}>{busy ? "Deleting…" : review ? target ? "Delete thread" : `Delete ${count} ${count === 1 ? "thread" : "threads"}` : "Review deletion"}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
