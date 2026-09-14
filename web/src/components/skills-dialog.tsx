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
import { MessageMarkdown } from "./message-markdown";
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
  const [search, setSearch] = useState("");
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [id, setId] = useState("");
  const [previews, setPreviews] = useState<Record<string, SkillPreview>>({});
  const [file, setFile] = useState("");
  const [folder, setFolder] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
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
      setFolder(next.folder);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (open) {
      setStatus("");
      void refresh();
      if (initialId) setId(initialId);
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
    setHistory(undefined);
    void api<SkillPreview>(`/api/skills/${encodeURIComponent(id)}`)
      .then((preview) => {
        if (active) {
          setPreviews((current) => ({ ...current, [id]: preview }));
          setFile(Object.keys(preview.files)[0] ?? "");
        }
      })
      .catch((reason) => setError(String(reason)));
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
  const filtered =
    library?.skills.filter(
      (item) =>
        (!enabledOnly || item.enabled) &&
        `${item.name} ${item.description} ${item.source}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="w-[min(1000px,calc(100%-2rem))] gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>Skills & Markdown</DialogTitle>
          <DialogDescription>
            Enabled skills are available for discovery. Select a skill to
            request it in your next message. “Read by agent” is recorded in run
            details.
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
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Search skills"
            className="min-w-0 flex-1 rounded border border-line bg-panel p-2 text-sm"
            placeholder="Search skills…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={enabledOnly}
              onChange={(e) => setEnabledOnly(e.target.checked)}
            />
            Enabled only
          </label>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setChoosing(!choosing)}
          >
            Choose folder
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!online}
            onClick={() => onAuthor()}
          >
            Create from recent work
          </Button>
        </div>
        {choosing && (
          <form
            className="flex flex-wrap gap-2"
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
              <input
                className="mt-1 block w-full rounded border border-line p-2"
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
        <p className="break-all text-xs text-muted">
          {library?.folder}
          <button
            className="ml-2 text-accent"
            disabled={!library}
            onClick={() =>
              void navigator.clipboard.writeText(library!.folder).then(
                () => setStatus("Folder path copied"),
                () => setError("Could not copy folder path."),
              )
            }
          >
            Copy folder path
          </button>
        </p>
        {library?.diagnostics.map((message, index) => (
          <p key={index} className="text-xs text-warn">
            {message}
          </p>
        ))}
        <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-[260px_minmax(0,1fr)]">
          <div
            className={`max-h-[50dvh] space-y-1 overflow-auto ${id ? "hidden md:block" : ""}`}
          >
            {loading && !library && <p role="status">Loading skills…</p>}
            {!filtered.length && !loading && (
              <p className="p-2 text-sm text-muted">
                {library?.skills.length
                  ? "No matching skills."
                  : "No skills discovered. Choose an existing Markdown folder, or create a skill from recorded work."}
              </p>
            )}
            {filtered.map((item) => (
              <button
                key={item.id}
                className={`w-full rounded border p-2 text-left ${item.id === id ? "border-accent bg-accent/5" : "border-line"}`}
                onClick={() => {
                  setId(item.id);
                  setFile("");
                }}
              >
                <strong className="block text-sm">{item.name}</strong>
                <span className="mt-1 block text-xs text-muted">
                  {item.description}
                </span>
                <span className="mt-1 block text-xs">
                  {item.source} · {item.enabled ? "Enabled" : "Disabled"}
                  {selected.includes(item.id)
                    ? " · Selected for next message"
                    : ""}
                </span>
              </button>
            ))}
          </div>
          <section
            className={`min-w-0 max-h-[55dvh] overflow-auto ${!id ? "hidden md:block" : ""}`}
            aria-label="Skill preview"
          >
            {id && (
              <button
                className="mb-2 text-xs text-accent md:hidden"
                onClick={() => setId("")}
              >
                Back to skills
              </button>
            )}
            {skill ? (
              <>
                <h3 className="font-semibold">{skill.name}</h3>
                <p className="my-1 text-xs text-muted">{skill.description}</p>
                <div className="my-2 flex flex-wrap gap-2">
                  <label className="text-xs">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={!online}
                      onChange={(e) => void toggle(skill, e.target.checked)}
                    />
                    Enabled
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
                <label className="text-xs">
                  Reference file
                  <select
                    className="my-2 block w-full rounded border border-line bg-panel p-1"
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
                    <div className="break-words text-sm">
                      <MessageMarkdown text={preview.files[file] ?? ""} />
                    </div>
                  ))}
                <details
                  className="mt-4 text-xs"
                  onToggle={(e) => {
                    if (e.currentTarget.open && online)
                      void api<{
                        revisions: SkillRevision[];
                        expired: boolean;
                      }>(`/api/skills/${encodeURIComponent(id)}/revisions`)
                        .then(setHistory)
                        .catch((reason) => setError(String(reason)));
                  }}
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
