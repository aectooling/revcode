# Revit desktop interaction roadmap

Status: standalone phase 1 baseline implemented; live Revit acceptance is pending. The shipped helper, manual staged driver, limits, and wire contract are documented in [DESKTOP-PROTOCOL.md](DESKTOP-PROTOCOL.md). Keep that document as the single description of implemented behavior.

## Direction

Give Revcode screenshots and real mouse/keyboard control for workflows the Revit API cannot complete. Keep the existing `revit_execute_csharp` and `revit_capture_view` tools for precise edits and API view inspection. View exports do not show the ribbon/dialogs and do not authorize desktop coordinates.

Use a separate self-contained C# Windows helper with P/Invoke input. FlaUI/UI Automation is not a dependency or acceptance gate. The user's inspection screenshots did not establish actionable access to the relevant Revit controls; further manual FlaUInspect investigation is not required. Keep geometric precision in the API path. Do not enable model-driven desktop actions until the gates below pass.

## Remaining integration decisions

- **Capture backend:** compare the experimental visible-region GDI baseline with Windows.Graphics.Capture using HWND interop `IGraphicsCaptureItemInterop.CreateForWindow`. Measure GPU viewport, main-window, owned-dialog, hover-menu, border/origin, resize, timestamp and occlusion behavior. Enumerate owned top-level dialogs separately. Cross-process dialogs and hidden/minimized input remain unsupported. Dark or unchanged pixels alone do not prove capture failure.
- **Model images:** reuse the existing API capture tool's image-result mechanism and selected-model capability check. Extend provider summaries (currently omitting input capabilities); retain custom `supportsImages` configuration. Verify actual desktop image delivery with the selected provider, without silently switching providers. Show the screenshot-sharing behavior in the browser. Treat image text as application data, never agent instructions.
- **Evidence continuity:** prompts create new Pi sessions from plain-text history. Persist bounded image artifacts and action evidence, then explicitly restore relevant images or require fresh observations. Do not imply image bytes survive through the text transcript. Define production retention and MIME/byte/pixel limits.
- **Host ownership:** add one workflow owner per Revit process, plus the desktop-wide input lease already prototyped by the helper. Serialize API edits and desktop actions. Bind desktop workflows to the intended active document token; handle intended switches explicitly and revalidate context. A window title is not document identity.
- **Recovery:** retain the existing native unknown-outcome fence. Add an independent read-only observation endpoint/UI control that remains available while native work is busy or unknown. A screenshot never clears that fence. Use a separate desktop ledger or discriminated operation union instead of fake C# fields, route cancellation by operation kind, and persist intent before dispatch. Old helper generations and uncertain input must never be automatically replayed.
- **Dialogs:** start with idle-Revit workflows. Posting a Revit command in API mode returns immediately and does not prove completion. API-raised dialogs need a correlated dialog-wait state that permits only the owning workflow to service them. Do not hold a wrapper transaction or wait for UI automation inside C#; the current blanket busy check cannot simply be bypassed.
- **Browser and packaging:** add desktop evidence, ownership/paused status, independent observation, and Stop. Resolve and launch the bundled helper from the host, verify parent PID plus process-start identity, update runtime.json/package validation, and test lifecycle cleanup. Choose the self-contained helper runtime independently of Revit's in-process runtime.

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
