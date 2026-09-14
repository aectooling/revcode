# Skills, run inspection, and C# highlighting

Date: 2026-09-15. Status: implemented; automated verification recorded in [docs/FEATURE-VALIDATION.md](docs/FEATURE-VALIDATION.md). Live Revit/provider validation remains unavailable.

This is the feature and acceptance reference for the Revcode update. The previous architecture and delivery plan is preserved in [docs/ARCHITECTURE-PLAN.md](docs/ARCHITECTURE-PLAN.md). Existing desktop work remains documented in [docs/DESKTOP-UI-PLAN.md](docs/DESKTOP-UI-PLAN.md). Verification and its limits are recorded separately.

## 1. Agreed scope

Users need to discover and manage skills, inspect tools by conversation run, and read or type highlighted C#. They must also be able to ask the agent to create or revise a reusable skill from recorded work.

- Adapt Hoppercode's skills browser: search, descriptions, previews, enable/disable, custom Markdown folders, and explicit selection for the next message.
- Let the agent create and edit user skills, supporting Markdown, and reusable C# examples, with saved diffs and revision restoration.
- Support “make a skill from this run,” extraction from several selected runs, and “update that skill with what we learned.”
- Expand the right inspector leftward on wide screens and upward on narrow screens, using an expand/restore button and draggable resizing.
- Group tools by run, where one accepted user message starts one run. Provide search, filters, and navigation between messages and their tools.
- Use Shiki for displayed C# and while typing in the console, with code controls and recoverable console drafts.

“Create and edit tools” means authoring skills and supporting files here. Skills describe how to use existing APIs; this update does not let the agent redefine executable host/native tools.

## 2. Current implementation and reuse

`web/src/components/execution-history.tsx` displays a flat operation list in a fixed 320 px desktop panel. On narrow screens it sits below the conversation with a 38dvh limit. The disclosure control hides content but does not enlarge the inspection area.

`src/host/server.ts` persists messages and operations without durable run associations. Its transient desktop turn identifier is insufficient for history. Snapshot limits independently truncate messages and operations, so array positions and timestamps cannot reliably reconstruct runs.

`src/host/pi-agent.ts` explicitly disables skills and built-in tools, and primarily subscribes to assistant text events. Skill support needs host and agent integration. The native operation journal also cannot represent every agent tool call.

The current Markdown renderer, execution inspector, and console use plain code rendering/input.

Reuse Hoppercode's `web/src/components/skills-dialog.tsx`, `src/host/skills.ts`, relevant tests, and `docs/skills.md`. The inspected local checkout is `C:/Users/tomosandego/playground/hopper-pi`, HEAD `51c677b60bb5709a1181868192b80d29cfb92348`. Confirm actual source provenance when copying, including any local modifications. Adapt types, authentication, data directories, and UI primitives to Revcode. Preserve MIT attribution in `THIRD_PARTY_NOTICES.md`; do not copy Rhino/Grasshopper-specific skill content.

## 3. Skills browser and library

### Interface

Add Skills & Markdown to the left sidebar, its collapsed icon rail, and narrow-screen settings. Open a responsive searchable dialog with list and preview panes; use list/detail navigation on small screens.

Show name, description, source, enabled state, and reference files. Support enabled-only filtering, individual toggles, content previews, copying the folder path, and entering an existing custom folder. Show loading, empty, offline, and discovery-error states. Browsing local skills does not require a configured model provider.

Offer **Create from recent work** and **Choose folder** in the empty state. The first action prepares an authoring request with explicit source runs; it explains when no usable history or configured provider is available. Browsing requires the local host, but not a live Revit connection. When the host is offline, show cached content as stale and disable mutations.

Add **Use in next message** in the browser and a searchable skill picker beside the composer. Represent selections as removable chips and submit stable skill IDs with the request. Distinguish **Enabled** (available for automatic discovery), **Selected for next message** (explicitly requested), and **Read by agent** (recorded evidence, not proof that every instruction was followed). Selected skills must be enabled; offer an explicit enable-and-select action for a disabled skill. Keep selections if submission fails and clear them after acceptance. Reject stale or unavailable selections with an actionable error rather than silently substituting a skill.

Store preferences and the default skills folder in Revcode's existing shared user data location, independent of per-instance operation history. Persist the selected folder and disabled skill IDs across restarts. Changing folders does not move or delete files. Refresh while idle and before each prompt. Settings changes during an active run apply to the next run.

Show **Applies next run** after changing settings or saving content during a run. Use revision-checked preference updates under a cross-process lock so simultaneous hosts cannot silently lose one another's changes. Re-read shared preferences before each prompt and during idle refresh. Qualify skill IDs by canonical library root/source and normalized relative path; on Windows, treat case-only path variants as the same identity. Identical filenames in different libraries must not share enabled state. A rename or move may create a new identity; do not claim rename tracking.

### Discovery

- Standalone `.md` files become skills, with optional name/description frontmatter and filename/content fallbacks.
- A directory containing `SKILL.md` owns its Markdown references and `.cs` examples up to, but excluding, nested skill roots. The nearest ancestor skill root owns a supporting file. Supporting files do not become independent skills.
- Standalone `.cs` files are not skills and examples never execute automatically.
- Separate bundled and user sources. Work correctly when the bundled catalog is empty; only Revit-relevant bundled content may ship.
- Start with Hoppercode's bounds of 256 KiB per supported file and 500 supported files per library. Report invalid or omitted entries without hiding the whole library.
- Skip unsupported files and symlinks/junctions that could escape the library. Keep identifiers stable across refresh and content edits.

### Host and agent integration

Introduce a host skill library owning discovery, preferences, validated reads, and snapshots. Add authenticated list, preview, and settings endpoints using existing server conventions.

At prompt start, obtain a consistent snapshot of enabled skill metadata and contents. Feed its catalog through the installed Pi SDK's supported resource-loader interface. Register a restricted reader for enabled skill Markdown and C# examples. General shell/edit/write tools remain disabled. Update the exact tool-inventory assertion for the deliberately registered skill/history tools.

Snapshot consistency does not mean injecting all file contents into the prompt. Send a bounded metadata catalog and retrieve content from the immutable run snapshot on demand. Explicitly selected skills are prioritized and their instructions are read before related work; record successful reads with skill ID, revision, and file path. Keep catalog availability, explicit selection, and actual reads separate in history. Authoring reads of disabled skills are labeled separately and do not count as workflow activation.

Define named limits for catalog size, per-read output, and cumulative skill context in the contract stage, independently of the 256 KiB file/500-file discovery limits. Include SDK-generated catalog text in the budget. If the catalog exceeds its budget, reserve space for explicit selections, include remaining entries in stable order, disclose omissions, and provide bounded search over the enabled snapshot. Large reads support explicit ranges and truncation markers. If explicit selections cannot fit, ask the user to narrow them before accepting the request. Never silently drop selected instructions or describe partially read content as complete.

Keep the active run's catalog and readable contents stable. Newly saved content appears in the browser immediately but becomes instructions for the next run. Disabling a skill does not remove text already present in conversation history.

## 4. Agent skill creation and editing

### Authoring API

Provide explicit tools to read a user skill for editing, create a skill with supporting files, and update an existing skill against an expected revision. Authoring reads can inspect a disabled user skill when requested; disabled content still stays out of the automatic catalog. Provide structured run-history access separately.

Restrict writes to the configured user skills folder and supported `.md`/`.cs` files. Validate normalized paths and resolved parents, reject traversal and escaping filesystem links, bound payload sizes, and validate the resulting skill before saving. Reject Windows case-insensitive destination collisions. Bind each authoring request to its library root and revision; a concurrent folder change must produce a conflict, never redirect the write. Use revision checks and a shared cross-process write lock to coordinate participating Revit hosts. Recheck file revisions immediately before replacement and retain recoverable prior content. External editors do not honor this lock: detect observed changes and report conflicts, without claiming that a check-and-replace sequence prevents every external-write race. Stage multi-file changes and define recoverable interrupted-update behavior; do not claim atomic multi-file updates without proving it.

Bundled skills are immutable through this API. Customization creates a user copy with its own ID. Existing names/destinations produce conflicts rather than silent overwrites. Preserve an edited skill's enabled state. Newly created skills default to enabled for the next run. General deletion and arbitrary filesystem mutation are out of scope; revision restoration has the narrow file-set exception defined below.

Return the saved ID, revision, changed files, and readable change summary. Link authoring results to the skill browser. Explicit conversational requests authorize routine creation/editing without another confirmation dialog. On a conflict, re-read and reconcile or ask a focused question if intent is ambiguous.

Retain bounded revision history outside discoverable skill content. Show a file-by-file saved diff and **Restore previous revision** in the browser. Restoration checks the current revision and library root, creates a new revision, preserves enabled state, and applies to the next run. It restores the supported file set, including removal of files introduced by the revision being reversed; this narrowly scoped restoration is allowed, while general deletion remains out of scope. A conflict never overwrites newer edits silently. Set revision count/byte limits in the contract stage, display when older revisions expire, and retain at least the immediately preceding complete revision for every accepted update. If that recovery copy cannot be retained, fail before changing files.

### Authoring without native execution

Provide an explicit **Skill authoring** composer mode, also used by create/update actions in the browser and inspector. With the local host and a configured provider available, this mode may read recorded history and read/create/update skills while Revit is disconnected or native outcomes are unresolved. Register only skill/history tools for this mode; omit C# execution, captures, and desktop tools on the server. It must not clear native fences, replay operations, or require a live document. Keep one agent request active per host; this does not introduce parallel work during an active execution run. Normal chat retains its existing execution gates. Label the mode and its unavailable modeling capabilities clearly, and provide an explicit switch back to normal chat.

### Creating a skill from a run

The authoring message itself starts a new run. By default, “this run” refers to the latest preceding work run, skipping runs explicitly recorded as skill authoring. Classify normal-chat authoring requests before source resolution; if intent is ambiguous, ask a focused question. Explicit run numbers or prompt references take precedence. Merely selecting a browser filter does not silently change the model's interpretation. If there is no suitable source run, ask which workflow to capture.

Add **Create skill from this run** on each run and an explicit selection action for several runs. Include source IDs as structured request data and show the selected run numbers/prompts before submission. Preserve their chronological order so a workflow such as create, correct, then verify can be captured together. **Update an existing skill** also supplies the destination skill ID. Resolve run numbers within the originating host history; use globally unambiguous instance/run references for provenance. Do not silently add neighboring runs or replace missing sources. Missing or pruned evidence must be disclosed; ask for clarification when it prevents a reliable procedure.

Read each source request, ordered tool arguments, linked C# operations, results, diagnostics, assistant response, and recorded environment/skill context. Produce:

- A clear name, description, and conditions for use.
- Inputs, prerequisites, document targeting, and context checks.
- A reusable procedure with optional C# examples.
- Verification steps and useful failure/recovery guidance.
- An honest distinction between confirmed success and incomplete, failed, or unknown outcomes.

Replace incidental document IDs, paths, and values with parameters or discovery steps. Retain failed attempts only when they teach a useful correction. Never turn unverified work into a claimed successful recipe or paste a whole transcript as a skill. Avoid copying secrets into persistent instructions. Store source-run provenance without making the skill depend on retained history.

Report what was saved and provide a preview link. Follow-up revisions use the current skill plus new evidence and preserve unrelated instructions.

## 5. Durable runs and tool history

### Records and lifecycle

Version persisted state and add these associations:

| Record | Information |
| --- | --- |
| Run | Stable ID, instance ID, display number, request ID, user/assistant message IDs, prompt preview, start/end times, lifecycle status, work/authoring intent and execution/authoring mode, source-run references, provider/model IDs, available Revit version and initial document context, catalog snapshot reference, selected and read skill IDs/revisions |
| Tool call | Run-scoped stable ID, tool name, sequence, arguments, times, status, structured result/error, linked operation IDs and artifact references |
| Operation | Existing native receipt plus optional run/tool-call association, actual bound document token and title captured at submission, execution mode |
| Message | Existing fields plus optional run ID |

Create a run once per accepted user request; HTTP retries must reuse the recorded request response and never duplicate runs. Include all model iterations, tool calls, and repair attempts within that run. Runs with no tools remain selectable.

Keep run lifecycle and individual tool/operation outcomes distinct: an assistant finishing does not imply every operation succeeded. On restart, mark unfinished activity interrupted or unknown as appropriate, preserving confirmed native receipts and the existing no-replay rules.

Document context belongs to each operation as well as the run: one run may legitimately target several documents. Preserve available document kind and context timestamps, identify session-scoped tokens as historical references, and do not resolve them against a later Revit session. Record missing environment metadata as unavailable rather than guessing. Initial run context is not proof of the actual target of every later tool.

### Capture and retrieval

Use the installed Pi SDK's tool lifecycle events to capture C# execution, captures, desktop observations/actions, skill reads/writes, and history reads. Verify event payloads and cancellation semantics against installed types. Correlate internal native operations to their parent call so a capture's internal C# appears as detail instead of a duplicate call. Record failures that occur before native dispatch.

Persist meaningful lifecycle transitions through the existing serialized persistence mechanism. Do not persist on every streamed token. Bound structured results, identify truncation explicitly, and use artifact references for screenshots instead of repeating base64 in snapshots. Show missing/expired artifacts clearly and protect history/artifact access with existing authentication.

Add paginated run summaries and on-demand details for browser and agent use. Support server-side prompt search and status/tool filters across retained history, not just loaded pages. Use stable cursor pagination so new runs do not duplicate or skip older results. Do not build grouping from the existing independent snapshot slices. Retrieve associated messages on demand for navigation beyond transcript snapshot limits. Keep code and diagnostics within documented bounds; disclose missing evidence to the agent synthesizing a skill. History-tool results should reference source records rather than recursively copying whole histories into new histories.

Manual console executions appear in a separately labeled Manual console group, not a fabricated message run. Legacy records lacking reliable association appear under Older history. Migrate without losing messages, settings, operations, or deduplication records; never infer old run links from timestamps alone.

### Retention and persistence cost

Before implementing storage, define named limits for retained completed-run details, aggregate text/result bytes, individual and aggregate artifact bytes, and skill revision backups. Document defaults and expose a concise retention description in history. Prune oldest eligible completed details/artifacts when limits are reached and keep lightweight summaries marking unavailable evidence. Protect sources while an accepted authoring request is reading them. Never prune active/unresolved receipts, settings, or request deduplication records as a side effect of history cleanup. If protected records exhaust a storage budget, surface the condition and stop accepting affected work instead of discarding recovery evidence. Migration itself remains lossless; retention runs as a separate documented operation.

Keep archived run details and artifacts outside the frequently rewritten live journal, behind the existing serialized persistence coordination. Snapshots carry bounded summaries and references, not all retained records or skill contents. Store artifact files before publishing references and clean up orphaned files through a recoverable process. Pagination must not leave whole-history serialization on each tool transition. Preserve read access to retained legacy history without rewriting its entire payload on each new event.

## 6. Responsive tool inspector

### Expansion and resizing

Evolve ExecutionHistory into a tool/run inspector. Retain the compact desktop width as the starting state, add expand/restore, and put a draggable separator on the left edge. On narrow screens keep the inspector below the conversation with a top-edge separator, growing upward.

Clamp sizes to the actual viewport/container so the composer and conversation remain reachable. Use an expanded preset around 60% available width on desktop and 70dvh on narrow screens, subject to minimum/maximum constraints. Save desktop width and narrow height separately in local preferences and clamp on viewport changes. Content collapse remains distinct from panel expansion.

Support pointer, touch, and keyboard resizing with accessible separator labels/values and visible focus. Keep the heading, filter, and sizing controls outside the scrolling details region. Long snippets and results must not overflow the page.

### Grouping and details

Default to All runs, with newest groups first and calls chronological within each run. Label groups and dropdown entries with run number, prompt preview, and status. Provide the full prompt in group details. Include Manual console and Older history when relevant.

Add prompt search, an errors-only filter, and a tool-type filter. Define errors-only to include failed/unknown calls and failed/interrupted runs, even if the assistant eventually finished. Show active filters, clear controls, and a distinct no-matches state. In a matching run, show matching calls first with an option to reveal the full run so filtering does not erase recovery context.

Preserve an explicit selected run when new work arrives. All runs receives new groups live. Keep the user's reading position when groups arrive or older pages load; follow live activity only while the user is already at the live edge. Otherwise show **New activity** with a jump-to-latest action. Handle empty, loading, interrupted, no-tools, and unavailable-history states.

Add **View tools** to chat messages and **Jump to message** to run details. Resolve navigation by IDs and fetch older associated content when necessary; explain unavailable targets. Explicit navigation may change the run filter but must preserve the composer draft. Show a readable run summary such as **Finished · 1 failed call**, document names, and a description derived from the prompt/tool metadata. Keep agent completion, individual call outcomes, and native transaction outcomes distinct. Display recorded provider/model and skill revisions in expandable context details.

Show tool name, status, duration, inputs, and result/error. C# detail includes batch steps, verification code, diagnostics, logs, and transaction outcomes. Image tools link to previews. Skill authoring links to saved content and change summaries. Preserve user disclosure choices during updates rather than reopening/closing details based solely on status.

Inspection never dispatches old code or desktop actions.

## 7. C# highlighting and console input

Use [Shiki's fine-grained imports](https://shiki.style/guide/bundles) with one cached, lazily loaded highlighter, the C# grammar, and one theme matching Revcode. Recognize `csharp`, `cs`, and `c#` fences. Leave other and unlabelled Markdown code as plain text.

Share a highlighted-code component across operations, batch/verification snippets, C# Markdown blocks, and skill examples. Render tokens or a controlled syntax tree safely; do not enable arbitrary Markdown HTML. Preserve exact copied source, memoize unchanged code, and display readable plain text during loading or failure.

Provide **Copy** with success/failure feedback, a wrap toggle, and line numbers excluded from copied source. Link diagnostics to the correct snippet, batch step, or verification source and line when that source is retained. Historical links reveal historical code; they do not replace the current console draft or run it. Handle unavailable source or out-of-range locations explicitly.

Build a small highlighted textarea for console snippets, batch steps, and verification inputs. Keep a native textarea for editing and selection with a synchronized syntax layer. Match font metrics, whitespace, wrapping, padding, and scrolling. Preserve caret, selection, undo/redo, clipboard, and IME composition. Debounce costly work and retain usable plain input if highlighting fails.

Persist console draft source, execution mode, batch step names/code, and verification with debounced writes to host-owned per-instance storage so a changed local server origin does not silently lose drafts. Keep drafts separate from executed history and surface persistence failures without blocking editing. Restore after reload, provide **Clear draft**, and never execute restored content automatically. Revalidate the saved document target after reload/reconnect; preserve it when it still identifies the same open document in the same Revit session. Require reselection for stale or unverifiable targets and never silently fall back to the active document. Make Ctrl/Cmd+Enter behavior consistent across snippet, batch, and verification editors and suppress submission during IME composition.

Do not add a full editor framework just for coloring. Verify the chosen Shiki engine against supported browser environments. Import C# explicitly, avoid a broad language bundle, and measure compressed initial and lazy-loaded asset increases against the baseline.

## 8. Delivery sequence

1. Inspect installed SDK interfaces, verify Hoppercode provenance, record existing checks/bundle sizes, and define versioned contracts, named context/storage budgets, retention defaults, and recovery behavior before dependent implementation.
2. Implement run migration, lifecycle capture, environment/skill context, operation correlation, bounded storage, and searchable history endpoints. Validate identity/retry/cancellation/restart behavior before authoring depends on it.
3. Port skill discovery, revision-checked shared preferences, authenticated endpoints, bounded catalog/search/reads, dialog, sidebar entry, onboarding, and composer selection. Extend reference support deliberately to C#.
4. Add restricted authoring mode, create/update/restore capabilities, saved diffs, conflict handling, and explicit multi-run extraction with provenance. Deliver selection, extraction, and revision recovery before optional visual polish.
5. Build grouping/search/filtering, message/run navigation, readable summaries, specialized tool details, stable scrolling, expansion/restoration, accessible resizing, and saved panel dimensions.
6. Integrate shared Shiki rendering, code controls, diagnostic navigation, highlighted console editing, and recoverable drafts; measure asset cost and input behavior.
7. Run checks and browser scenarios; update usage/testing documentation, any bundled-skill packaging, and attribution.

Primary locations: `src/host/types.ts`, `server.ts`, `pi-agent.ts`, new skill/history modules, `web/src/main.tsx`, `sidebar.tsx`, `execution-history.tsx`, `message-markdown.tsx`, `console-panel.tsx`, new dialog/highlighting/editor components, and host/browser tests.

Keep run metadata host-side where possible. A native execution redesign is unnecessary. If a native contract does change, include transport validation and corresponding smoke tests.

## 9. Acceptance and verification

### Host/agent checks

- Migration preserves old state and never invents run associations.
- One accepted message creates one run; duplicate submissions cannot duplicate records or work.
- Multiple iterations, errors, cancellation, and restart preserve accurate call associations and outcomes.
- Non-C# tools appear; linked internal operations are not duplicated.
- History beyond snapshot limits is accessible, with explicit truncation and missing artifacts.
- Discovery handles standalone skills, references, invalid files, folder changes, and persisted preferences.
- Enabled catalog snapshots stay consistent during a run; revisions become instructions next run.
- Authoring rejects escaped paths, unsupported content, collisions, stale revisions, and bundled writes; concurrent and interrupted updates are tested.
- A skill created from recorded work can be read and used in a later run, then revised without losing unrelated instructions.
- Explicit skill selections survive failed submission, resolve against the accepted snapshot, and are distinguished from actual reads; context-budget overflow is disclosed.
- Multi-run extraction preserves explicit source order and environment context, skips authoring runs only for default selection, and discloses missing evidence.
- Revision restoration creates a new revision without changing enabled state or overwriting concurrent edits; cross-host preference updates preserve unrelated changes.
- Restricted authoring works without live Revit and with unresolved native work, but cannot invoke native tools, bypass fences, or overlap an active agent request.
- Retention protects active evidence, unresolved receipts, and deduplication records; archived payloads stay out of frequent journal rewrites and snapshots.
- Search/cursor retrieval includes older retained records, navigation resolves associated messages, and restored drafts cannot submit against stale or unverifiable targets.

### Browser checks

- Skills are reachable from expanded, collapsed, and narrow layouts; browsing, search, previews, toggles, folders, and failures behave clearly.
- All runs has visible boundaries; individual filtering remains stable during updates.
- Expansion grows in the requested direction; pointer/keyboard resizing keeps essential controls reachable and avoids page overflow.
- Details retain disclosure choices and support selecting/copying code.
- C# highlights in messages, tool details, skill examples, and every console mode; fallbacks remain readable.
- Console caret, selection, scrolling, undo, paste, and IME remain correct with highlighting.

Feature completion also includes composer skill selection, explicit multi-run source selection, saved diffs/restoration, message/run navigation, history search, stable scrolling, code controls, and draft recovery described above. The additional review proposal for an expanded browser acceptance matrix (long-history stress, maximum-sized snippets, 200% zoom, mobile keyboard-open layouts, and a dedicated dialog focus/WAI audit) is deferred for now. Existing browser checks above remain in scope.

Run `npm run check` and the appropriate existing browser smoke suite extended with focused mocked scenarios. Add meaningful tests for migration, event correlation, filesystem boundaries, and conflicts. Run native/transport checks if those contracts change. Inspect real-browser wide/narrow layouts and record bundle measurements. Perform a live Revit/provider workflow involving multiple tools, skill creation, and reuse when available; disclose unavailable live validation separately.

## 10. Completion and boundaries

Done means users can browse and explicitly select usable skills; create, revise, and restore them from one or several recorded runs; inspect every recorded tool through searchable groups and message navigation in an expandable/resizable panel; and read/type highlighted C# with code controls and recoverable drafts. Restricted authoring remains available without native execution when the local host/provider are available. State/preferences survive reload/restart, retention and missing evidence are explicit, and required checks pass.

No further user decision is required to begin implementation. This plan chooses behavior for skill selection, run references, revision recovery, restricted authoring, legacy/manual history, enabled state, and refresh timing. The contract stage must record concrete context/storage budgets and retention defaults, the smallest compatible Pi/Shiki integration, and a recoverable file-update mechanism before dependent work proceeds. These are engineering decisions within the agreed scope.

Out of scope: arbitrary executable tool generation, a marketplace, automatic skill deletion, full IDE features, replaying historical operations, and a new native execution architecture.
