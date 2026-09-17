import { Archive, ArchiveRestore, ChevronDown, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { ThreadSummary } from "../../../src/host/types";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export function ThreadList({
  threads,
  selectedId,
  activeId,
  online,
  onSelect,
  onCreate,
  onArchive,
}: {
  threads: ThreadSummary[];
  selectedId: string;
  activeId?: string;
  online: boolean;
  onSelect(id: string): void;
  onCreate(): void;
  onArchive(thread: ThreadSummary): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const rows = [...threads].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const week = new Date(today);
  week.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const group = (row: ThreadSummary) => {
    const time = new Date(row.updatedAt).getTime();
    return time >= +today
      ? "Today"
      : time >= +yesterday
        ? "Yesterday"
        : time >= +week
          ? "This week"
          : "Older";
  };
  const renderRow = (row: ThreadSummary) => (
    <div
      key={row.id}
      className={cn(
        "group flex items-center rounded-md hover:bg-surface",
        selectedId === row.id && "bg-surface",
      )}
    >
      <button
        type="button"
        disabled={!online}
        onClick={() => onSelect(row.id)}
        aria-current={selectedId === row.id ? "page" : undefined}
        title={row.title}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span
          aria-label={activeId === row.id ? "Working" : "Inactive"}
          className={cn(
            "mt-1.5 size-[7px] shrink-0 rounded-full bg-line-strong",
            activeId === row.id && "bg-accent motion-safe:animate-pulse",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">
            {row.title}
          </span>
          <span className="block truncate text-[10.5px] text-muted">
            {row.documentLabel || "No document"}
            {activeId === row.id ? " · Working" : ""}
          </span>
        </span>
      </button>
      <button
        type="button"
        disabled={!online || activeId === row.id}
        aria-label={`${row.archivedAt ? "Unarchive" : "Archive"} ${row.title}`}
        title={
          activeId === row.id
            ? "Stop the running thread first"
            : row.archivedAt
              ? "Unarchive"
              : "Archive"
        }
        onClick={() => onArchive(row)}
        className="mr-1 rounded p-1.5 text-muted hover:text-ink disabled:opacity-40"
      >
        {row.archivedAt ? (
          <ArchiveRestore className="size-3.5" />
        ) : (
          <Archive className="size-3.5" />
        )}
      </button>
    </div>
  );
  const archived = rows.filter((row) => row.archivedAt);
  return (
    <nav
      aria-label="Thread history"
      className="min-w-0 border-b border-line pb-3"
    >
      <Button
        variant="secondary"
        className="w-full justify-start"
        disabled={!online}
        onClick={onCreate}
      >
        <Plus className="size-4" />
        New thread
      </Button>
      {["Today", "Yesterday", "This week", "Older"].map((label) => {
        const members = rows.filter(
          (row) => !row.archivedAt && group(row) === label,
        );
        return members.length ? (
          <section key={label} aria-label={label}>
            <h2 className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {label}
            </h2>
            {members.map(renderRow)}
          </section>
        ) : null;
      })}
      {archived.length > 0 && (
        <section className="mt-2 border-t border-line pt-1">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-xs text-ink-soft"
          >
            <Archive className="size-3.5" />
            Archived ({archived.length})
            <ChevronDown
              className={cn("ml-auto size-3.5", expanded && "rotate-180")}
            />
          </button>
          {expanded && (
            <>
              <p className="px-2 pb-1 text-[10px] text-muted">
                Read-only. Unarchive to continue.
              </p>
              {archived.map(renderRow)}
            </>
          )}
        </section>
      )}
    </nav>
  );
}
