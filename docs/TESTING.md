# Testing Revcode

The MVP separates automated host/compiler tests from actual Revit behavior. A passing build alone cannot prove that Revit API context, transaction rollback, Undo, or installed dependency resolution works.

## Automated checks

Run `npm run check` for TypeScript checks, host tests, and the production web/host build. Host tests use actual ZeroMQ sockets and a simulated native peer to exercise authentication, request deduplication, document binding, result delivery, and uncertain outcomes. Provider network calls should be simulated in automated tests; no paid API key is required.

Run `npm run test:native` for compiler, collectible assembly, and document wrapper identity tests. Run `npm run test:transport` for an actual .NET 8 NetMQ exchange with the runtime's Immutable assembly already loaded. Run `npm run test:browser` and `npm run test:provider-ui` after `npm run build` for production UI checks in installed Microsoft Edge. Provider UI checks use the real Pi SDK with a simulated OAuth provider, including browser/code prompts, cancellation, shared credential reuse, model selection, and custom keyless endpoints. All credential fixtures use isolated temporary files, never your real Pi credentials.

## Measured native validation (2026-09-13)

The installed package was exercised in **Revit 2026.3, build 26.3.0.37, running .NET 8.0.31**, using a newly created disposable project. The following passed through the production Node host and actual ZeroMQ/NetMQ bridge:

- Level query returned actual model data.
- Invalid C# returned a diagnostic on snippet line 2.
- Level creation committed; a subsequent query found the created element.
- Creating an element then throwing rolled back; a subsequent query confirmed absence.
- Returning a Revit object after creating an element failed serialization and rolled back; absence was verified.
- Normal Revit toolbar Undo removed the successful edit in one step.
- The production browser C# console verified that Undo; reloading restored history without dispatching another operation.

The live checks exposed and fixed two issues that compilation alone missed: NetMQ's incompatible Immutable 10 dependency under Revit's .NET 8 runtime, and reference-based identity for Revit's replaceable managed document wrappers. Both now have regression coverage. A separate test interrupted by ordinary Revit shutdown correctly produced an unknown outcome and did not replay the operation.

Revit 2025 and 2027 compile against their installed API assemblies; they have not received the same in-application validation. Revit 2026.5/.NET 10 remains an untested update profile. External paid-provider requests and real account sign-in are not automated validation claims; authentication and Pi's tool loop are checked with local fixtures.

## Repeat the disposable-project check

The native test hook is opt-in and refuses an existing active document. Set `REVCODE_SMOKE_DIR` to an absolute test output directory and optionally `REVCODE_NO_BROWSER=1` only in the environment of a newly launched Revit process. On its first Idling callback, the add-in creates, saves, and opens a new uniquely named project, then writes `smoke-project.txt`. It never targets an existing user project.

```powershell
node scripts/smoke-revit.mjs '<instance-dir>\discovery.json' '<test-dir>\smoke-project.txt' '<test-dir>\results.json'
# Use normal Revit Undo once, then:
node scripts/smoke-browser-revit.mjs '<instance-dir>\discovery.json' '<test-dir>\results.json' '<test-dir>\browser.png'
```

The first script runs the live query/edit/rollback checks. The second drives the real browser and verifies Undo. Both reject a mismatched document. Do not copy discovery credentials into test reports or issue comments. The discovery file lives under `%LOCALAPPDATA%\Revcode\instances\<instance-id>`.

## Manual Revit acceptance

Use a new disposable project. Record the Revit executable build, runtime, Revcode commit, and installed package path.

| Check | Expected result |
| --- | --- |
| Click ribbon twice | Existing host is reused; usable browser opens without a terminal |
| Levels query | Real current model data, JSON result, no edit transaction |
| Invalid C# | Compiler error points to a snippet line; model unchanged |
| Create a uniquely named level | `succeeded`, `Committed`, level visible on a follow-up query |
| Undo in Revit | The successful edit disappears in one normal Undo step |
| Create then throw | `failed`, `RolledBack`, no created level remains |
| Return an unsupported Revit object after edit | Serialization fails before commit; edit rolls back |
| Switch document before a queued call runs | Edit stays bound to the original open target; new active model unchanged |
| Close the target before a queued call runs | Closed token rejected; no fallback to the active model |
| Edit an inactive project by token | Transaction commits in that project; active project unchanged |
| Load an open family into another project in API mode | `succeeded`, `ApiManaged`; follow-up query finds the family in the target project |
| Open/create a document with no active model in API mode | New document is discoverable via `ctx.Documents` and the next context snapshot |
| Throw after an API side effect | `unknown`; no claim that the earlier effect rolled back; subsequent execution fenced |
| Revit modal/edit command active | Waiting status, no background-thread API access |
| Cancel while queued | Operation cancels without starting a model edit |
| Cancel cooperative running code | Current transaction rolls back at a cancellation check |
| Browser reload during call | State reconnects, mutation is not replayed |
| Disconnect after native dispatch | Outcome marked unknown until confirmed; new writes blocked |
| Agent asks for levels then edits | Real Pi tool execution uses the same native executor as the console |
| Close Revit | Its local host exits; another Revit process is unaffected |

Save/sync, worksharing permissions, family documents, arbitrary API calls, and runtime updates need their own targeted tests before treating them as supported workflows. No tests should mutate an existing user project without a deliberate test instruction.

## View capture smoke check

With an image-capable model and a disposable Revit project, ask the agent to list exportable views and capture a non-active plan or 3D view by UniqueId. Confirm that the image matches the requested view and the active tab stays unchanged. Then zoom the active view and request `region: visible`; confirm the image reflects the viewport. Request visible capture of an inactive view and confirm a useful error without switching tabs. Use a separate API call to request activation, verify the active view in a subsequent query, and capture again.

Also check a template view, a closed document token, a text-only model, and cancellation. No capture should create an Undo entry. Successful captures should leave no PNG in the instance's `captures` directory. Capture images reach the agent within the current turn; browser execution history contains metadata, not an image preview. The automated SDK fixture verifies image delivery, but does not exercise Revit graphics rendering.

Compare captures of the same view with `zoomType: "zoom"` at 50% and 100%; confirm that output dimensions change while viewport framing remains unchanged. Verify omitted zoom uses 50%, default fit-to-page uses 1536 horizontal pixels, and conflicting sizing arguments fail before dispatch. Repeat with `region: "visible"`. Percentage mode uses 150 DPI and may exceed the pixel dimensions allowed by fit-to-page; test the 10 MiB failure guidance with a large export.
