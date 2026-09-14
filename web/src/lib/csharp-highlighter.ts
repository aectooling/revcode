import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import csharp from "shiki/langs/csharp.mjs";
import githubLight from "shiki/themes/github-light.mjs";

// The WASM engine works in WebView2 and avoids ES2024 RegExp requirements.
const highlighter = createHighlighterCore({
  langs: [csharp], themes: [githubLight],
  engine: createOnigurumaEngine(import("shiki/wasm")),
});

export async function highlightCsharp(code: string) {
  return (await highlighter).codeToTokens(code, { lang: "csharp", theme: "github-light" }).tokens;
}
