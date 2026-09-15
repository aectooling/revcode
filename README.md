# Revcode

A local, Pi-powered coding assistant for Revit. Click **Revcode** in Revit to open a browser workspace, chat about the active model, or run C# directly. The agent uses `revit_execute_csharp` for modeling, `revit_capture_view` for API view images, and `revit_ui_observe` / `revit_ui_action` for experimental desktop interaction.

This is an early, full-trust prototype. Use a disposable project for your first test. Running snippets execute inside Revit; an uncooperative script can block its UI. Stop cancels queued work and requests cooperative cancellation, and does not undo earlier committed edits.

## Install the local prototype

Build prerequisites: Windows x64, the pinned Node, pnpm, and .NET SDK versions in `release.config.json` and `global.json`, and matching Revit API references. Revit 2025 supports separate .NET 8 and .NET 10 variants; Revit 2026 requires 2026.5+/.NET 10; Revit 2027 uses .NET 10. See [deployment and releases](docs/DEPLOYMENT.md) for compatibility, pnpm installation, signing, and release commands. Clients need Node for installation/CLI bootstrap; the running application uses bundled Node and self-contained helpers.

From PowerShell in this repository:

```powershell
pnpm install --frozen-lockfile
pnpm run build:install
```

Use `pnpm run build` to build only the host and browser. The checked-in pnpm workspace configuration allows the required esbuild and ZeroMQ install scripts and skips optional dependency scripts.

`build:install` runs the production build, stages and verifies a versioned package, and registers the per-user add-in without prompting. `pnpm run build:install --open-revit` reopens Revit after installation, `pnpm run build:install --build-only` builds and verifies the package without installing, and `pnpm run build:install --revit-years 2025,2026` selects versions. The same flags work when calling Node directly: `node scripts/build-install.mjs --open-revit --revit-years 2025,2026`.

Close Revit before activation. The installer registers compatible detected installations and copies a verified payload under `%LOCALAPPDATA%\Revcode\packages`. It does not require administrator privileges. Unsigned local builds may show Revit's standard add-in prompt. Use the [deployment guide](docs/DEPLOYMENT.md) for deferred activation, diagnostics, rollback, and complete removal.

The individual steps behind `build:install` are also available separately:

```powershell
./scripts/package.ps1 -RevitYears 2025,2026,2027
./scripts/install.ps1
```

To install a specific package, including a package copied from another machine:

```powershell
./scripts/install.ps1 -PackagePath 'C:\path\to\revcode-package'
```

The package includes the Node executable, production npm dependencies (including ZeroMQ's native binary), compiled browser/host files, an isolated self-contained Roslyn compiler, and selected Revit add-in builds. Autodesk API DLLs are resolved from the installed Revit and are not redistributed.

## Try it

1. Open Revit and create a disposable project.
2. On the **Add-Ins** ribbon, click **Revcode**. A hidden local Node host starts and opens the browser.
3. Check the connected document shown in the workspace. In the C# console, run the **Levels** query. No model provider is needed for this test.
4. Try creating a level. A successful edit has a `Committed` transaction and can be undone normally in Revit.
5. Try the rollback example: it creates a level and then throws. The operation must fail with `RolledBack`; the level must not remain.
6. Open **Set up a provider**, connect a provider with browser sign-in or an API key, and select a model. Ask: “List the levels in this project, including their elevations in millimeters.”
7. Try: “Create a level named Revcode test at 4500 mm, then verify it exists.”

Provider requests use your account and its normal billing. The direct C# console and the agent use the same native execution path.

Open **Skills & Markdown** from the sidebar or composer to browse instructions, choose a custom folder, enable skills, and select them for the next message. The run inspector groups tools by accepted message, supports search and filters, and links back to the conversation. Select one or several runs to create a reusable skill, or update an existing skill; saved diffs and revision restoration are available in its preview. **Skill authoring** mode works with a configured provider even when Revit is disconnected, and has no native execution or desktop tools. See [skills and revision recovery](docs/skills.md), [history/storage contracts](docs/FEATURE-CONTRACTS.md), and [C# highlighting and console draft recovery](docs/CSHARP-HIGHLIGHTING.md).

## Connect a provider

Provider setup lets you review connected providers, search the Pi catalog, choose a sign-in method, then select a model. Browser sign-in is offered when supported by that provider, including subscription-backed providers exposed by Pi. Follow the browser/device-code instructions; if a provider requests a code or another field, enter it in the setup dialog. API-key entry remains available for providers that support it. Sign-in can be cancelled, and connections can be refreshed or disconnected.

Existing Pi sign-ins are reused. Credentials are managed by Pi's own storage and cross-process refresh locks, normally at `~/.pi/agent/auth.json`. `PI_CODING_AGENT_DIR` changes that base directory; `REVCODE_PI_AUTH_PATH` overrides the credential file explicitly. Signing out affects the shared Pi credential for that provider. Credentials are never included in the model conversation or retained in browser storage.

Custom OpenAI-compatible endpoints can be added with a provider ID, API base URL, model ID(s), and optional API key. A blank key supports local endpoints that do not require authentication. Custom model definitions live in `%LOCALAPPDATA%\Revcode\user\models.json`; actual keys stay in Pi credential storage. The selected model persists across Revit launches.

Browser refresh restores the current transcript and results. The tab can be closed while work continues. Reopen it using the ribbon button. Multiple Revit processes get independent hosts/tabs in this prototype. A switched or closed document cannot silently redirect an already-submitted edit.

The blue **r/** ribbon icon matches the browser favicon. Its main click always opens Revcode. Use the small dropdown arrow for **Restart Revcode**, **Stop Revcode**, or **Check status**, including when no document is open. Restart and Stop show a brief Revit dialog; Check status reports Starting, Running, Stopping, Restarting, Stopped, or a failure message for this Revit instance.

Stop cancels pending native work and shuts down the local host. Restart waits for the old host and native work to settle, then opens a fresh browser tab; the previous tab can be closed. Neither action undoes completed model edits. Restart preserves native operation identities and any execution block caused by an unresolved transaction; such a block still requires inspecting the model and restarting Revit.

## C# contract

Enter the body of `object? Execute(RevcodeContext ctx)`, without a class wrapper:

```csharp
return new FilteredElementCollector(ctx.Doc)
    .OfClass(typeof(Level))
    .Cast<Level>()
    .Select(level => new {
        id = level.UniqueId,
        name = level.Name,
        elevationMm = UnitUtils.ConvertFromInternalUnits(
            level.Elevation, UnitTypeId.Millimeters)
    })
    .ToArray();
```

Available context: `ctx.Doc`, `ctx.UiDoc`, `ctx.UiApp`, `ctx.Log(string)`, and `ctx.CheckCancellation()`. Default imports include System, LINQ, generic collections, and Autodesk.Revit.DB/UI. Use query mode for inspection and modify mode for edits. Return materialized JSON-safe data, not Revit elements, lazy collectors, tasks, or delegates.

The agent and console can target any open non-linked document by its session token. Omitting `documentToken` binds the active document at submission; switching tabs never redirects submitted work. `ctx.Doc` is the bound target, while `ctx.UiDoc` always refers to the active UI document. Discover documents with `ctx.Documents`, `ctx.GetDocumentToken(document)` and `ctx.GetDocument(token)`. Closed targets are rejected.

Revcode owns the target transaction in modify mode. Use separate calls for edits to separate documents. Do not open your own transactions, start background tasks or retain Revit objects. Use `api` mode for document creation/opening, EditFamily, family-document loading, save/sync/close and export. It opens no wrapper transaction and has no whole-call rollback or single-Undo guarantee. Revit API restrictions still apply. Synchronous task-related file access is allowed. Query and API modes work with no document open; `ctx.Doc` then throws, but `ctx.UiApp` and `ctx.Documents` remain available.

The compiler detects common unsupported patterns; it is not a sandbox. A modify call commits as one Undo item or rolls back on a confirmed execution failure. Successful API calls report `ApiManaged`; check API return values and query afterward. Exceptions, cancellation or invalid results after an API snippet starts report `unknown`, because earlier effects may persist. An unknown outcome blocks subsequent execution and must be inspected rather than automatically retried.

To load an open family into a project, first query:

```csharp
return ctx.Documents.Select(d => new {
    token = ctx.GetDocumentToken(d), title = d.Title, isFamily = d.IsFamilyDocument
}).ToArray();
```

Choose the project as the target, select **API** mode, and run:

```csharp
var family = ctx.GetDocument("<family token>").LoadFamily(ctx.Doc);
return new { id = family.UniqueId, name = family.Name };
```

For reload conflicts, the overload accepting `new RevitUIFamilyLoadOptions()` can show Revit's conflict prompts. Edit family geometry beforehand in a separate modify call targeted to the family, then verify the loaded family with a query targeted to the project.

## Visual inspection

`revit_capture_view` returns a PNG directly to an image-capable agent model. In custom-provider setup, select each vision model under **Models that accept images**; unselected models remain text-only. For an existing custom provider, set that model’s `input` to `["text", "image"]` in the shared `models.json` and refresh providers. It accepts optional `documentToken`, `viewId` (a view UniqueId), `pixelSize` (256-2048, default 1536), `zoomType` (`fitToPage` or `zoom`), `zoom` (integer percentage), and `region` (`view` or `visible`). Without a view ID it uses the target document's active view at execution time.

Export sizing follows Autodesk's [ImageExportOptions](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/c2e823a1-6eb0-2bf3-f07b-ed46d8f7b70a.htm):

- `zoomType: "fitToPage"` is the default and uses `pixelSize` as the horizontal pixel count.
- `zoomType: "zoom"` uses `zoom` as the export percentage at 150 DPI. Omitted `zoom` defaults to 50, matching [Revit's Zoom default](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/6ab4f8bb-3abb-8c49-eefd-642e9d57a262.htm). The tool accepts integer percentages from 1 to 1000; Revit enforces its own export constraints.
- `zoom` requires `zoomType: "zoom"`; supplying `pixelSize` in that mode is rejected because Revit would ignore it. Effective sizing options are returned with the capture metadata.

For example, `{ "viewId": "<view-unique-id>", "zoomType": "zoom", "zoom": 100 }` exports at 100%. This controls raster export sizing, not viewport framing or the Revit view scale. To focus on an element, use C# to change the crop/section box or the active viewport before capturing. Percentage sizing can produce images wider than 2048 pixels; the 10 MiB output cap still applies.

The default `view` region exports the whole view using Revit's `SetOfViews`; activation is unnecessary. `visible` exports the current zoomed viewport and requires the target document and view to already be active. This is a Revit image export, not a desktop screenshot. Templates and non-printable views are rejected. Graphics/export failures are returned as `captureError`; they do not imply model changes.

Use C# queries to discover views by name and UniqueId and inspect exact element data. Use C# to adjust camera orientation, crop or section boxes, then capture again. If viewport capture requires changing tabs, call `ctx.UiDoc.RequestViewChange(view)` in a separate API call and verify the active view afterward: the request is asynchronous.

Images require a model whose Pi definition includes image input. Custom endpoints initially declare text input only; update the model's `input` to `["text", "image"]` in the shared `models.json` and refresh providers if the endpoint supports vision. Captures use the existing execution journal and document binding. Temporary PNGs are removed after confirmed completion; uncertain executions retain their unique directory under the instance's `captures` folder. PNG bytes bypass the native JSON result limit and are capped at 10 MiB. New Pi sessions are in-memory: images are not written to session logs or carried into later chat turns; recapture when needed. Existing session files from older versions are not deleted.

## Agent desktop tools

The installed host now launches the bundled desktop helper on demand. No manual driver or separate setup is needed after rebuilding/installing this version and restarting Revit. Select a model with image input support.

- `revit_ui_observe({windowRef?, crop?, maxWidth?})` returns a PNG of the actual Revit window, including ribbon, Project Browser and visible owned dialogs, with an observation ID and geometry. The host acquires exclusive desktop control and attempts to focus Revit once on the first call in a turn.
- `revit_ui_action({observationId, action, ...})` performs one `move`, left `click`, `scroll`, Unicode `type`, or named `key` chord. Pointer actions use coordinates from the fresh image. The result contains a dispatch receipt and another screenshot; dispatch alone does not prove the UI operation succeeded.

Try in a disposable project: **“Use revit_ui_observe to inspect the Revit ribbon and Project Browser. Describe what is visible without changing anything.”** Then: **“Use the desktop tools to find Project Browser search, click it, type REVCODE_TEST, inspect the result, and clear the text. Stop if the control is ambiguous.”** Keep Revit visible and leave the mouse/keyboard alone during agent input. A fresh actionable frame expires after 15 seconds; the model must observe again if needed.

A frosted full-screen computer-use overlay appears in chat during preparation, recovery and control; a static notice covers Revit's monitor while native control is active. The overlay includes the latest agent screenshot, a cursor marker at capture time, and timestamped observation/action receipts. The left sidebar lists the four registered tools and their availability, and retains the recent activity feed after control ends (for the current host session). The native notice shows control/recovery status and the emergency Stop shortcut without capturing a backdrop; detailed activity and cursor evidence remain in chat. Typed content is not shown in the activity feed. The native curtain is excluded from agent screenshots and does not take focus or intercept input; it is a visual status screen, not a Windows lock. Agent tool screenshots are sent to the selected provider. **Stop and take control** in chat, the normal Stop button, or **Ctrl+Alt+F12** in Revit stop future input; they do not undo prior actions. A lost lease also aborts the agent turn. Desktop actions remain blocked during pending/unknown API work, after a detected active-document switch, or after uncertain desktop input. Document checks use the cached native snapshot (whose age is included in tool evidence), so they are best effort during dialogs; do not switch documents during a workflow. Do not retry unknown actions; inspect Revit and start a new Revit/Revcode session after resolving the outcome.

The host journals intent/receipts separately from C# operations, retains only the latest desktop PNG, and requires fresh observations across turns. New Pi sessions run in memory, avoiding duplicate screenshot files and synchronous image-log writes; the host text journal supplies conversation continuity. Existing session logs from older versions are not deleted. The helper is bound to Revit PID plus process-start identity and uses a user/session input mutex. It never elevates or kills Revit.

Desktop control is **experimental**: visible-region GDI capture is implemented; WGC comparison and live Revit workflow validation remain pending. The first UI observation restores and brings Revit forward automatically, waiting for focus before capture. Switching away during control pauses the workflow. Input requires an active, unlocked Windows session (console or connected Remote Desktop) and matching integrity levels. Cross-process dialogs, arbitrary popup targeting, and dialogs raised by a still-running API call are unsupported. See [desktop protocol and limits](docs/DESKTOP-PROTOCOL.md).

## Atomic edit batches

Use `batch` mode when several edits to **one document** must succeed together. Inspect first, prepare all named steps, and submit one request with an explicit `documentToken`. The console has a batch step editor; the agent uses the same `revit_execute_csharp` tool.

```json
{
  "mode": "batch",
  "documentToken": "<open document token>",
  "transactionName": "Create and name a level",
  "steps": [
    { "name": "Create", "code": "var level = Level.Create(ctx.Doc, 15); return new { id = level.UniqueId };" },
    { "name": "Name", "code": "var level = ctx.Doc.GetElement(ctx.StepResults[0].GetProperty(\"id\").GetString()); level.Name = \"Batch level\"; return level.UniqueId;" }
  ],
  "verify": { "code": "return ctx.Doc.GetElement(ctx.StepResults[0].GetProperty(\"id\").GetString()).Name == \"Batch level\";" }
}
```

All steps and optional verification compile before editing. Each step owns an inner transaction within one synchronous transaction group. Verification runs without a transaction and must return exactly `true`; omission means no extra acceptance check. Confirmed success assimilates the group into one Undo entry. An exception, invalid result, failed verification or cooperative cancellation rolls back the group; uncertain cleanup reports `unknown` and blocks further execution.

`ctx.StepResults` contains earlier materialized `System.Text.Json.JsonElement` results, available only within the batch. Limits are 1–20 steps, 64 KiB combined source/imports, 256 KiB aggregate result payload (with space reserved for receipts), and 100 log lines/16,000 characters. History distinguishes `committed`, `rolledBack`, `notRun`, and `unknown` steps. Rolled-back element results are discarded.

This guarantee covers transaction-backed edits to the target during normal execution. It does not cover crashes, other documents, save/sync/export, document lifecycle, family loading, or filesystem/network effects. Recognized unsupported calls are rejected by the compiler; arbitrary C# remains full trust. Never retry individual steps or automatically replay an uncertain batch.

## Architecture

```text
Revit ribbon -> hidden Node host -> React browser UI (local HTTP)
                       |
                  embedded Pi
                       |
              revit_execute_csharp
                       |
          ZeroMQ ROUTER <-> NetMQ DEALER
                       |
        isolated Roslyn compiler process
                       |
       Revit ExternalEvent + transaction
```

Compilation happens outside Revit to isolate Roslyn dependencies. The emitted assembly executes synchronously inside Revit through `ExternalEvent`, with a collectible load context sharing the host's Revit API types. Both queries and writes use this path. ZeroMQ has a dedicated socket-owning thread in the add-in; it stays responsive during execution.

The browser and native connection use separate credentials and bind only to loopback. The host records operation intent before dispatch, and duplicate request IDs do not replay edits. A disconnect after dispatch creates an uncertain outcome until a retained native receipt reconciles it. There is no claim of exactly-once execution across a Revit crash.

See [desktop protocol and limits](docs/DESKTOP-PROTOCOL.md) for the desktop interaction contract and recovery rules.

## Development and limits

```powershell
pnpm run build       # Host + browser
pnpm run check       # Typecheck, host tests, production build
node scripts/smoke-host-lifecycle.mjs # After build: host stop/restart smoke test
pnpm run build:install --build-only   # Stage and verify a package without installing
pnpm run build:install --open-revit   # Build, install, and reopen Revit
```

Native add-in changes require closing Revit and reinstalling. C# snippets compile on each call and require no restart. Browser assets and Node dependencies are served from the installed versioned package, so rebuilding the repository alone does not update an installed package.

The prototype has one execution owner per Revit process, one explicit document target per call, and one transaction per modify call. It does not implement a shared multi-process scheduler, multi-agent workflows, NuGet dependencies, atomic multi-document rollback, or an embedded Revit panel. Revit year builds are distinct; compiling them does not establish compatibility with every future update, including the .NET 10 transition within Revit 2026.

To uninstall, close Revit and run `./scripts/uninstall.ps1`. This removes only Revcode's manifests, preserving settings, history, and versioned package files.

MIT license. The shipped Pi, ZeroMQ, Roslyn, React, and Node dependencies retain their own licenses.
