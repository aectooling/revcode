import { ArrowLeft, BookOpen, ChevronRight, Copy, FolderOpen, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  SkillLibrarySnapshot,
  SkillPreview,
  SkillRevision,
  SkillSummary,
} from "../../../src/host/skills";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SkillMarkdown } from "./skill-markdown";
import { HighlightedCode } from "./highlighted-code";
export type SkillsApi = <T>(path: string, body?: unknown) => Promise<T>;
export function SkillsDialog({
  open,
  onClose,
  api,
  online,
  busy,
  selected,
  onSelect,
  onAuthor,
  initialId,
}: {
  open: boolean;
  onClose(): void;
  api: SkillsApi;
  online: boolean;
  busy: boolean;
  selected: string[];
  onSelect(skill: SkillSummary): void;
  onAuthor(skill?: SkillSummary): void;
  initialId?: string;
}) {
  const [library, setLibrary] = useState<SkillLibrarySnapshot>();
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [id, setId] = useState("");
  const [previews, setPreviews] = useState<Record<string, SkillPreview>>({});
  const [file, setFile] = useState("");
  const [folder, setFolder] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<{
    revisions: SkillRevision[];
    expired: boolean;
  }>();
  const refresh = async () => {
    if (!online) return;
    setLoading(true);
    try {
      const next = await api<SkillLibrarySnapshot>("/api/skills");
      setLibrary(next);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setFolder(library?.folder ?? "");
  }, [library?.folder]);
  useEffect(() => {
    if (open) {
      setStatus("");
      void refresh();
      if (initialId) {
        setId(initialId);
        setQuery("");
        setEnabledOnly(false);
      }
      setDetailOpen(Boolean(initialId));
    }
  }, [open, online, initialId]);
  useEffect(() => {
    if (!open || busy || !online) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [open, busy, online]);
  useEffect(() => {
    if (!id || !online || !open) return;
    let active = true;
    void api<SkillPreview>(`/api/skills/${encodeURIComponent(id)}`)
      .then((preview) => {
        if (active) {
          setPreviews((current) => ({ ...current, [id]: preview }));
          const entryFile = preview.skill.path.slice(preview.skill.root.length).replace(/\\/g, "/").replace(/^\//, "");
          setFile(current => current in preview.files ? current
            : entryFile in preview.files ? entryFile : Object.keys(preview.files)[0] ?? "");
        }
      })
      .catch((reason) => { if (active) setError(String(reason)); });
    return () => {
      active = false;
    };
  }, [
    id,
    open,
    online,
    library?.revision,
    library?.skills.find((item) => item.id === id)?.revision,
  ]);
  useEffect(() => {
    setHistory(undefined);
    if (!open || !historyOpen || !id || !online) return;
    let active = true;
    void api<{ revisions: SkillRevision[]; expired: boolean }>(
      `/api/skills/${encodeURIComponent(id)}/revisions`,
    ).then(result => { if (active) setHistory(result); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [open, historyOpen, id, online, library?.skills.find(item => item.id === id)?.revision]);
  const preview = previews[id];
  const skill =
    library?.skills.find((item) => item.id === id) ?? preview?.skill;
  const update = async (body: unknown) => {
    try {
      const next = await api<SkillLibrarySnapshot>(
        "/api/skills/settings",
        body,
      );
      setLibrary(next);
      setStatus(busy ? "Applies next run" : "Settings saved");
      setError("");
      return true;
    } catch (reason) {
      setError(String(reason));
      void refresh();
      return false;
    }
  };
  const toggle = async (item: SkillSummary, enabled: boolean) =>
    update({
      expectedRevision: library?.revision,
      type: "enabled",
      id: item.id,
      enabled,
    });
  const search = query.trim().toLowerCase();
  const filtered = library?.skills.filter(item => (!enabledOnly || item.enabled)
    && `${item.name} ${item.description} ${item.path}`.toLowerCase().includes(search)) ?? [];
  const groups = [
    { source: "bundled", name: "Bundled", icon: BookOpen },
    { source: "user", name: "Your Markdown", icon: FolderOpen },
  ].map(group => ({ ...group, skills: filtered.filter(item => item.source === group.source) }));
  useEffect(() => {
    if (library && !filtered.some(item => item.id === id)) {
      setId(filtered[0]?.id ?? "");
      setFile("");
    }
  }, [library, query, enabledOnly, id]);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="h-[min(680px,calc(100dvh-2rem))] w-[min(920px,calc(100%-2rem))] gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>skill.md</DialogTitle>
          <DialogDescription>
            Instructions and references Revcode can read. Enable skills to make
            them available for your next request.
          </DialogDescription>
        </DialogHeader>
        {!online && (
          <p role="status" className="text-xs text-warn">
            Host offline · cached content is stale. Reconnect to change your
            library.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {status && (
          <p role="status" className="text-xs text-accent">
            {status}
          </p>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-48">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input aria-label="Search skills" placeholder="Search skills…" value={query}
              onChange={(e) => { setQuery(e.target.value); setDetailOpen(false); }} className="pl-8" />
          </div>
          <Button size="sm" variant={enabledOnly ? "default" : "secondary"}
            aria-pressed={enabledOnly} onClick={() => { setEnabledOnly(!enabledOnly); setDetailOpen(false); }}>
            Enabled only
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={choosing}
            aria-controls="skill-folder-settings"
            onClick={() => setChoosing(!choosing)}
          >
            <FolderOpen className="size-3.5" /> Choose folder
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!online}
            onClick={() => onAuthor()}
          >
            <Plus className="size-3.5" /> Create from recent work
          </Button>
        </div>
        {choosing && (
          <form
            id="skill-folder-settings"
            className="flex max-h-[30dvh] shrink-0 flex-wrap items-center gap-2 overflow-auto rounded-md border border-line bg-panel p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void update({
                expectedRevision: library?.revision,
                type: "folder",
                folder,
              }).then((ok) => {
                if (ok) setChoosing(false);
              });
            }}
          >
            <label className="flex-1 text-xs">
              Existing absolute folder
              <Input
                className="mt-1"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              />
            </label>
            <Button size="sm" disabled={!online} type="submit">
              Use folder
            </Button>
            <p className="w-full text-xs text-muted">
              Changing folders does not move or delete files.
            </p>
          </form>
        )}
        {choosing && <p className="break-all text-xs text-muted">
          {library?.folder}
          <button
            className="ml-2 inline-flex rounded p-1 align-middle text-muted hover:bg-surface-muted"
            aria-label="Copy folder path"
            title="Copy folder path"
            disabled={!library}
            onClick={() =>
              void navigator.clipboard.writeText(library!.folder).then(
                () => setStatus("Folder path copied"),
                () => setError("Could not copy folder path."),
              )
            }
          >
            <Copy className="size-3.5" />
          </button>
        </p>}
        <p className="shrink-0 text-xs text-muted">
          {library ? `${library.skills.filter(item => item.enabled).length} of ${library.skills.length} enabled${search || enabledOnly ? ` · ${filtered.length} matching` : ""}` : "Loading skills…"}
        </p>
        {library?.diagnostics.map((message, index) => (
          <p key={index} className="text-xs text-warn">
            {message}
          </p>
        ))}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-md border border-line sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          <div
            aria-label="Skills"
            className={`min-h-0 overflow-y-auto bg-panel sm:border-r sm:border-line ${detailOpen ? "hidden sm:block" : ""}`}
          >
            {loading && !library && <p role="status">Loading skills…</p>}
            {!filtered.length && !loading && (
              <p className="p-2 text-sm text-muted">
                {library?.skills.length
                  ? "No matching skills."
                  : "No skills discovered. Choose an existing Markdown folder, or create a skill from recorded work."}
              </p>
            )}
            {groups.filter(group => group.skills.length).map(group => (
              <section key={group.source} aria-label={group.name}>
                <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-line bg-panel/95 px-3 py-1.5 backdrop-blur">
                  <group.icon aria-hidden="true" className="size-3 text-muted" />
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{group.name}</h2>
                  <span className="ml-auto text-[11px] tabular-nums text-muted">{group.skills.filter(item => item.enabled).length}/{group.skills.length}</span>
                </div>
                <div className="py-1">{group.skills.map((item) => (
              <button
                key={item.id}
                aria-current={item.id === id ? "true" : undefined}
                className={`relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-2 text-left transition-colors hover:bg-ink/[.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${item.id === id ? "bg-surface before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-r before:bg-accent" : ""}`}
                onClick={() => {
                  if (item.id !== id) setFile("");
                  setId(item.id);
                  setDetailOpen(true);
                }}
              >
                <span aria-hidden="true" className={`mt-[7px] size-1.5 rounded-full ${item.enabled ? "bg-accent" : "border border-line-strong"}`} />
                <span className="min-w-0">
                <strong className="block truncate font-mono text-xs font-medium" title={item.name}>{item.name}</strong>
                <span className="mt-0.5 block truncate text-[11px] text-muted" title={item.description}>
                  {item.description}
                </span>
                <span className="sr-only">
                  {item.source} · {item.enabled ? "Enabled" : "Disabled"}
                  {selected.includes(item.id)
                    ? " · Selected for next message"
                    : ""}
                </span>
                </span>
                <ChevronRight aria-hidden="true" className="mt-1 size-3.5 text-muted sm:hidden" />
              </button>
            ))}</div>
              </section>
            ))}
          </div>
          <section
            className={`min-h-0 min-w-0 overflow-y-auto bg-surface p-4 sm:p-5 ${!detailOpen ? "hidden sm:block" : ""}`}
            aria-label="Skill preview"
          >
            {id && (
              <Button variant="ghost" size="xs"
                className="-ml-2 mb-2 sm:hidden"
                onClick={() => setDetailOpen(false)}
              >
                <ArrowLeft className="size-3" /> Back to skills
              </Button>
            )}
            {skill ? (
              <>
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                  <BookOpen aria-hidden="true" className="size-3" />{skill.source === "user" ? "Your Markdown" : "Bundled"}
                </div>
                <h3 className="mt-1 break-words font-mono text-base font-semibold tracking-tight">{skill.name}</h3>
                <p className="mt-3 break-words text-[13px] leading-6 text-ink-soft">{skill.description}</p>
                <div className="my-3 flex flex-wrap items-center gap-2">
                  <label className="flex w-full items-center gap-2 rounded-md border border-line bg-panel px-3 py-2.5 text-xs">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-accent"
                      checked={skill.enabled}
                      disabled={!online}
                      onChange={(e) => void toggle(skill, e.target.checked)}
                    />
                    <span><span className="block font-medium">Enabled</span><span className="text-[11px] text-muted">Available for Revcode to discover and read.</span></span>
                  </label>
                  <Button
                    size="sm"
                    disabled={!online || selected.includes(skill.id)}
                    onClick={async () => {
                      if (skill.enabled || (await toggle(skill, true))) {
                        onSelect({ ...skill, enabled: true });
                        setStatus("Selected for next message");
                      }
                    }}
                  >
                    {selected.includes(skill.id)
                      ? "Selected for next message"
                      : skill.enabled
                        ? "Use in next message"
                        : "Enable and select"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!online}
                    onClick={() => onAuthor(skill)}
                  >
                    {skill.source === "user"
                      ? "Update this skill"
                      : "Create a user copy"}
                  </Button>
                </div>
                <label className="mt-5 block text-xs font-medium">
                  Reference file
                  <select
                    className="my-2 block h-8 w-full min-w-0 rounded-sm border border-line bg-surface px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    value={file}
                    onChange={(e) => setFile(e.target.value)}
                  >
                    {Object.keys(preview?.files ?? {}).map((path) => (
                      <option key={path}>{path}</option>
                    ))}
                  </select>
                </label>
                {preview &&
                  file &&
                  (file.toLowerCase().endsWith(".cs") ? (
                    <HighlightedCode
                      code={preview.files[file] ?? ""}
                      label={file}
                    />
                  ) : (
                    <SkillMarkdown text={preview.files[file] ?? ""} />
                  ))}
                <details
                  className="mt-4 border-t border-line pt-3 text-xs text-ink-soft"
                  open={historyOpen}
                  onToggle={(e) => setHistoryOpen(e.currentTarget.open)}
                >
                  <summary>Saved diffs and revision restoration</summary>
                  {history?.expired && (
                    <p className="text-warn">
                      Older revisions expired under retention limits.
                    </p>
                  )}
                  {history && !history.revisions.length && (
                    <p>No saved revisions yet.</p>
                  )}
                  {history?.revisions
                    .slice()
                    .reverse()
                    .map((revision) => (
                      <details
                        key={revision.revision}
                        className="mt-2 border-t border-line pt-2"
                      >
                        <summary>
                          {revision.createdAt} · {revision.summary}
                        </summary>
                        {revision.changes.map((change) => (
                          <details key={change.path}>
                            <summary>{change.path}</summary>
                            <p>Before</p>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                              {change.before || "(file absent)"}
                            </pre>
                            <p>After</p>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
                              {change.after || "(file absent)"}
                            </pre>
                          </details>
                        ))}
                        {revision.revision !== skill.revision &&
                          skill.source === "user" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={!online}
                              onClick={async () => {
                                try {
                                  await api(
                                    `/api/skills/${encodeURIComponent(id)}/restore`,
                                    {
                                      root: skill.root,
                                      id,
                                      expectedRevision: skill.revision,
                                      revision: revision.revision,
                                      expectedPreferencesRevision:
                                        library?.revision,
                                    },
                                  );
                                  const next = await api<SkillPreview>(
                                    `/api/skills/${encodeURIComponent(id)}`,
                                  );
                                  setPreviews((current) => ({
                                    ...current,
                                    [id]: next,
                                  }));
                                  setHistory(undefined);
                                  setStatus(
                                    busy
                                      ? "Restored · Applies next run"
                                      : "Revision restored",
                                  );
                                  await refresh();
                                } catch (reason) {
                                  setError(String(reason));
                                }
                              }}
                            >
                              Restore previous revision
                            </Button>
                          )}
                      </details>
                    ))}
                </details>
              </>
            ) : (
              <p className="text-sm text-muted">
                Select a skill to preview its instructions and reference files.
              </p>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
