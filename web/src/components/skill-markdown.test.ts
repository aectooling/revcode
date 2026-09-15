import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkillMarkdown } from "./skill-markdown";

const render = (text: string) => renderToStaticMarkup(createElement(SkillMarkdown, { text }));

describe("SkillMarkdown", () => {
  it("separates Windows frontmatter from rendered instructions without losing YAML structure", () => {
    const html = render('\uFEFF---\r\nname: Levels\r\ndescription: |\r\n  First line\r\n  Second line\r\nmetadata:\r\n  tags: [revit]\r\n---\r\n# Instructions\nRead **carefully**.');
    expect(html).toContain('aria-label="Frontmatter"');
    expect(html).toContain("metadata:\r\n  tags: [revit]");
    expect(html).toContain("<h1>Instructions</h1>");
    expect(html).toContain("<strong>carefully</strong>");
    expect(html).not.toContain("<hr");
  });

  it.each(["# Instructions\n\n---\nname: body text\n---", "---\nname: Unclosed"])(
    "keeps ordinary Markdown and unclosed frontmatter visible: %s", (text) => {
      const html = render(text);
      expect(html).not.toContain('aria-label="Frontmatter"');
      expect(html).toContain("name:");
    },
  );

  it("escapes metadata and supports a closing delimiter at end of file", () => {
    const html = render('---\nname: <script>alert(1)</script>\n---');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
