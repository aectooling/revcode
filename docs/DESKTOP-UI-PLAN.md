# Revit desktop interaction roadmap

Status: standalone helper and experimental host/Pi/browser/package integration implemented. Both `revit_ui_observe` and `revit_ui_action` are registered and callable. Live Revit acceptance and capture-backend comparison remain pending. The shipped behavior is documented in [DESKTOP-PROTOCOL.md](DESKTOP-PROTOCOL.md); keep that document as the single description of implemented behavior.

## Direction

Give Revcode screenshots and real mouse/keyboard control for workflows the Revit API cannot complete. Keep the existing `revit_execute_csharp` and `revit_capture_view` tools for precise edits and API view inspection. View exports do not show the ribbon/dialogs and do not authorize desktop coordinates.

Use a separate self-contained C# Windows helper with P/Invoke input. FlaUI/UI Automation is not a dependency or acceptance gate. The user's inspection screenshots did not establish actionable access to the relevant Revit controls; further manual FlaUInspect investigation is not required. Keep geometric precision in the API path. At the user's request, model-driven desktop actions are now wired for experimental testing; the gates below remain required evidence before claiming reliability.

## Remaining integration decisions

- **Capture backend:** compare the experimental visible-region GDI baseline with Windows.Graphics.Capture using HWND interop `IGraphicsCaptureItemInterop.CreateForWindow`. Measure GPU viewport, main-window, owned-dialog, hover-menu, border/origin, resize, timestamp and occlusion behavior. Enumerate owned top-level dialogs separately. Cross-process dialogs and hidden/minimized input remain unsupported. Dark or unchanged pixels alone do not prove capture failure.
- **Model images:** implemented with actual image blocks, selected-model capability checks, provider summary capabilities and browser disclosure. Local model fixtures verify both desktop tools and image delivery through the real Pi SDK. Actual selected-provider/Revit workflow acceptance is still pending; never silently switch providers or treat image text as instructions.
- **Evidence continuity:** new Pi sessions run in memory from host text history; desktop storage retains only the latest PNG plus bounded action records. Fresh observations are required every turn. Older Pi session files are not deleted. Historical image browsing would need a separate bounded artifact policy.
- **Host ownership:** API/desktop exclusion, a per-turn owner and the user/session input mutex are implemented. The document guard uses cached native tokens and reports snapshot age; it is best effort while Idling is blocked. Intended document-switch orchestration remains unsupported. A window title is not document identity.
- **Recovery:** independent read-only capture, separate desktop journaling, generation checks, cancellation and native/desktop unknown fences are implemented. Automated tests cover suspended acceptance writes, disconnects and non-replay; live interruption acceptance remains pending. A screenshot never clears an unknown fence.
- **Dialogs:** start with idle-Revit workflows. Posting a Revit command in API mode returns immediately and does not prove completion. API-raised dialogs need a correlated dialog-wait state that permits only the owning workflow to service them. Do not hold a wrapper transaction or wait for UI automation inside C#; the current blanket busy check cannot simply be bypassed.
- **Browser and packaging:** the panel, authenticated image endpoint, Stop, lazy hidden launch, PID/start identity and runtime.json helper path are implemented. The helper uses a self-contained runtime independent of Revit. Browser smoke tests and package builds verify integration; installed live-Revit compatibility remains pending.

## Acceptance gates

| Phase | Required evidence before proceeding |
| --- | --- |
| 1. Standalone capture/input | Capture ribbon, Project Browser, GPU viewport, hover menu and owned dialog. Locate search from a screenshot; click, type a unique Unicode string, verify and clear it. Compare capture backends. Test 100%, 150%, 200%, mixed DPI, negative monitor origins, crop/resize, occlusion, focus refusal, integrity mismatch, competing helpers and local Stop. Record versions/backend/failures. The manual staged driver is the test harness, not proof these checks passed. |
| 2. Host tools and visual reasoning | Register `revit_ui_observe` and `revit_ui_action` alongside existing tools. Verify actual provider image delivery and evidence across turns. A selected vision model finds search after window movement; a text-only model cannot choose click coordinates. Prove ownership, cancellation, deduplication and unknown handling during model/capture waits. |
| 3. Complete UI workflow | Select one API-limited workflow from the user's actual task, including a dialog. Complete it and verify visible results plus API state where available. Record at least ten repetitions, every failure, action count and latency. Search alone is insufficient. |
| 4. Interruption and recovery | Test focus theft, unexpected dialogs, process/helper exit/restart, disconnect after click, duplicate requests, stale images, locked desktops, competing hosts and missing post-action screenshots. Confirm no replay or input into another app. Validate API-raised dialogs separately before claiming support. |
| 5. Packaging/compatibility | Installed package needs no SDK or manual scripts. Validate supported Revit/runtime profiles and report actual GPU, scaling, language and monitor coverage. |

Keep future tool input bounded to one semantic action per fresh observation. Pointer coordinates are image-relative, never element identities. Revalidate foreground, geometry, dialog state and target-point ownership immediately before dispatch; verify visible results afterward and query API state when meaningful. Unexpected dialogs or unmet postconditions stop the sequence. UI workflows have no whole-workflow rollback or single-Undo guarantee; Stop prevents future input and does not undo earlier effects.

Do not promise arbitrary dialogs, general canvas modeling, background desktop operation, or a delivery estimate before the gates provide evidence. The manual driver's exact image-match check is a conservative staging aid, not the future model targeting design.

## References

The implemented contract links the Microsoft input/capture references in [DESKTOP-PROTOCOL.md](DESKTOP-PROTOCOL.md). Additional integration references: [HWND capture interop](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow), [DPI awareness](https://learn.microsoft.com/en-us/windows/win32/hidpi/setting-the-default-dpi-awareness-for-a-process), [foreground activation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow), [hotkey registration](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey), and [Autodesk PostCommand](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API-MainReference/files/html/b0df464d-1733-ea9e-ac40-399fa9c9a037.htm). Documentation informs the design; it does not establish Revit compatibility.
