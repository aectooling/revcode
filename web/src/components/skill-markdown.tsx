import { MessageMarkdown } from "./message-markdown";

export function SkillMarkdown({ text }: { text: string }) {
  // Keep YAML verbatim: nested fields, comments, and multiline values are all
  // meaningful. Only a closed block at the start of the file is frontmatter.
  const frontmatter = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(text);
  const hasFrontmatter = frontmatter?.index === 0;
  return (
    <div className="overflow-hidden rounded-md border border-line bg-panel text-[13px] leading-6">
      {hasFrontmatter && (
        <section aria-label="Frontmatter" className="border-b border-line px-3 py-2.5">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Frontmatter</h4>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ink-soft">
            {frontmatter[1].trimEnd()}
          </pre>
        </section>
      )}
      <div className="break-words p-3">
        <MessageMarkdown text={hasFrontmatter ? text.slice(frontmatter[0].length) : text} />
      </div>
    </div>
  );
}
