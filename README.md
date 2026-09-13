# Revcode

A local, Pi-powered coding assistant for Revit. Click **Revcode** in Revit to open a browser workspace, chat about the active model, or run C# directly. The agent has one modeling tool: `revit_execute_csharp`.

This is an early, full-trust prototype. Use a disposable project for your first test. Running snippets execute inside Revit; an uncooperative script can block its UI. Stop cancels queued work and requests cooperative cancellation, and does not undo earlier committed edits.

## Install the local prototype

Build prerequisites: Windows x64, Node.js 22.19+, a .NET 10 SDK (which can build the .NET 8 targets), and installed Revit API assemblies for the selected year. Revit 2025/2026 builds target .NET 8; the 2027 build targets .NET 10. End users of a built package need Revit, but do not need Node or a .NET SDK.

From PowerShell in this repository:

```powershell
npm ci
npm run build:install
```

For pnpm, run `pnpm install --frozen-lockfile` followed by `pnpm run build` (host and browser) or `pnpm run build:install` (the full add-in). The checked-in pnpm workspace configuration allows the required esbuild and ZeroMQ install scripts and skips optional dependency scripts.

`build:install` runs the production build, stages and verifies a versioned package, and registers the per-user add-in without prompting. Options follow after ` -- ` (npm does not pass dashed flags): `npm run build:install -- open-revit` reopens Revit after installation, `-- build-only` builds and verifies the package without installing, and `-- revit-years 2025,2026` selects versions. When calling Node directly, dashed forms also work: `node scripts/build-install.mjs --open-revit --revit-years 2025,2026`.

Close Revit before installation. The installer registers a per-user add-in and copies a versioned package under `%LOCALAPPDATA%\Revcode\packages`. It does not require administrator privileges. Revit may show its standard unsigned add-in prompt on first load.

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

## Connect a provider

Provider setup follows Hoppercode's flow: review connected providers, search the Pi catalog, choose a sign-in method, then select a model. Browser sign-in is offered when supported by that provider, including subscription-backed providers exposed by Pi. Follow the browser/device-code instructions; if a provider requests a code or another field, enter it in the setup dialog. API-key entry remains available for providers that support it. Sign-in can be cancelled, and connections can be refreshed or disconnected.

Existing Pi sign-ins are reused. Credentials are managed by Pi's own storage and cross-process refresh locks, normally at `~/.pi/agent/auth.json`. `PI_CODING_AGENT_DIR` changes that base directory; `REVCODE_PI_AUTH_PATH` overrides the credential file explicitly. Signing out affects the shared Pi credential for that provider. Credentials are never included in the model conversation or retained in browser storage.

Custom OpenAI-compatible endpoints can be added with a provider ID, API base URL, model ID(s), and optional API key. A blank key supports local endpoints that do not require authentication. Custom model definitions live in `%LOCALAPPDATA%\Revcode\user\models.json`; actual keys stay in Pi credential storage. The selected model persists across Revit launches.

Browser refresh restores the current transcript and results. The tab can be closed while work continues. Reopen it using the ribbon button. Multiple Revit processes get independent hosts/tabs in this prototype. A switched or closed document cannot silently redirect an already-submitted edit.

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

See [PROTOCOL.md](PROTOCOL.md) for the implemented wire boundary, [PLAN.md](PLAN.md) for the longer-term architecture, and [docs/TESTING.md](docs/TESTING.md) for validation and manual checks.

## Development and limits

```powershell
npm run build       # Host + browser
npm run check       # Typecheck, host tests, production build
npm run build:install -- build-only   # Stage and verify a package without installing
npm run build:install -- open-revit   # Build, install, and reopen Revit
```

Native add-in changes require closing Revit and reinstalling. C# snippets compile on each call and require no restart. Browser assets and Node dependencies are served from the installed versioned package, so rebuilding the repository alone does not update an installed package.

The prototype has one execution owner per Revit process, one explicit document target per call, and one transaction per modify call. It does not implement the full plan's shared multi-process scheduler, multi-agent workflows, visual capture, NuGet dependencies, atomic multi-document rollback, or an embedded Revit panel. Revit year builds are distinct; compiling them does not establish compatibility with every future update, including the .NET 10 transition within Revit 2026.

To uninstall, close Revit and run `./scripts/uninstall.ps1`. This removes only Revcode's manifests, preserving settings, history, and versioned package files.

MIT license. Architecture inspired by [Hoppercode](https://github.com/tsoumdoa/hoppercode); this MVP uses its Pi-based host/native separation. The shipped Pi, ZeroMQ, Roslyn, React, and Node dependencies retain their own licenses.
