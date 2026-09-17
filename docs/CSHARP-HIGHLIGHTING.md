# C# highlighting and draft recovery

The shared code viewer supports C# (`csharp`, `cs`, `c#`), exact-source copying, line numbers, wrapping, and historical diagnostic line navigation. Other Markdown fences remain plain. HTML in Markdown is disabled; syntax tokens render as React text spans. The native console textarea preserves selection, undo, clipboard, and composition. Ctrl/Cmd+Enter submits from snippets, batch steps, and verification, except during IME composition. Sources over 100,000 characters remain plain to avoid blocking input.

Shiki 4.4.3 uses a single lazy highlighter, explicitly imported C# and JSON grammars and GitHub Light theme, and the Oniguruma WebAssembly engine. The [official fine-grained bundle guidance](https://shiki.style/guide/bundles) documents these imports. The [engine documentation](https://shiki.style/guide/regex-engines) confirms browser WebAssembly support and explains JavaScript engine runtime requirements. WebView2/Edge supports the chosen WASM engine; loading or tokenization failure keeps readable plain text. No full language/theme bundle or editor framework is shipped.

Console drafts use authenticated, debounced, serialized host writes, independently of execution history. Restoring a draft never runs it. Document targets must be revalidated against the same native session before reuse; unavailable session identity requires explicit reselection. Host outages leave editing usable and show unsaved status. A slow load never overwrites text typed while restoration was pending.

Run `pnpm run test:highlighting` for focused real Edge browser checks covering safe token rendering, exact copy (accounting for Windows clipboard newline normalization), unlabelled/non-C# fences, undo, IME suppression, shortcuts in each editor, narrow width, and synchronized horizontal/vertical scrolling. The suite uses an isolated Vite fixture and no live provider/Revit.

For payload measurements and bundling constraints, see [package size](PACKAGE-SIZE.md). Build-specific sizes belong in release artifacts rather than this implementation guide.
