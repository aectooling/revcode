# Desktop helper spike protocol

## Countdown and accidental-input recovery

Chat shows a three-second hands-off countdown before the first control request.
The helper then waits for 1.5 seconds without input events, cursor movement or held keys/buttons,
up to ten seconds, before acquiring foreground focus. Its non-activating,
click-through notice stays visible above other windows until Stop or turn end.
The chat Stop button cancels the countdown; Ctrl+Alt+F12 is registered once the
helper acquires its lease, including while it waits for initial quiet input.

Accidental input revokes the current screenshot rather than ending the turn.
The host shows a three-second recovery countdown, then polls for quiet input at
most twenty times, 500 ms apart (capture time is additional). The new `recover`
helper request requires an existing active lease and quiet input. It can return
focus to Revit once after the warning; the host does not repeatedly reacquire focus
within the same recovery episode after a successful recovery response. At most
three episodes are allowed per turn. Exhaustion releases control and explains the
pause. Stop, disconnect, document changes and unknown outcomes prevent recovery.

Recovery repeats observation, not input. A confirmed zero-input refusal plus a
fresh actionable screenshot is returned to the model as a recoverable result with
an instruction to continue the task. The model chooses a new action from that
image. Existing request IDs remain deduplicated. Partial input remains unknown
and is never replayed. Keyboard and mouse hooks on a dedicated message-pump thread
retain an event revision, so a completed tap between watchdog samples invalidates
the screenshot. Only this helper's tagged injected events are excluded. Revisions
are checked across capture and at dispatch; Windows input is still not atomic
against concurrent user activity. Delayed agent cursor moves are recognized
only near their expected destination within 500 ms to avoid false interruptions.

The native notice is static and shows status plus the emergency Stop shortcut.
It does not capture or blur the desktop. Detailed previews and activity remain
in chat. Input hooks follow Microsoft's [keyboard](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc) and [mouse](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc) callback contracts; callbacks only update an atomic revision.

## Native menus, WPF popups and interruption reporting

Native Revit popup menus (`#32768`) are included in observation metadata and window-change validation. A pointer action may hit one only when Windows reports active menu mode, matching menu/owner process IDs, the observed Revit window as owner, and the menu in the revalidated observation. Revit ribbon dropdowns use WPF `HwndWrapper[` popups instead. These are included only when visible, enabled, styled WS_POPUP + TOOLWINDOW + NOACTIVATE without TRANSPARENT, and owned by a window in the same process and UI thread whose owner chain reaches the bound Revit main window. Pointer validation additionally requires their owner to match the observed window and their presence in the revalidated observation. They never become the selected foreground/main window. Other applications' menus, newly appeared menus and unrelated overlays remain rejected.

Live validation on 2026-09-14 reproduced a zero-input refusal at View > Schedules > Schedule/Quantities: the WPF dropdown was incorrectly excluded as an auxiliary window. After rebuilding, a local driver invoking the production `revit_ui_observe` / `revit_ui_action` implementations completed this click and created `Wall Schedule` with Area, Count, and Family and Type. A fresh screenshot confirmed two wall rows. Input and stale-observation refusals recovered with fresh screenshots during the same workflow. This was a separate tool session with the rebuilt helper, not a model-driven retest of the already-running installed chat package; that package needs updating and restarting. Native regression tests cover the WPF style, process, thread and enabled-state predicates.

Known non-dispatch receipts reach the model as tool results. Stale or revoked observations retain control only while the native lease and interference checks remain valid; other refusals pause control. A lost-lease heartbeat that arrives while the action response is pending waits for receipt classification, so it cannot hide a refusal behind a generic SDK abort. Actual interruption after dispatched input still aborts, and chat preserves the desktop reason.

On 2026-09-14, the configured model completed the exact prompt “Using only UI tools, switch the current 3D view to an isometric orientation and set its visual style to Shaded” through the production Pi/DesktopController/DesktopClient stack against live Revit. All three clicks dispatched, including the Shaded popup item, and the resulting screenshot showed the shaded isometric view. This was a separate live test session using the rebuilt helper; the already-running installed chat host requires a reload to receive the correction.

## Background focus correction

A persistent helper can lose foreground permission after the user works in chat. If its direct request is refused, it temporarily registers an unassigned virtual-key hotkey (0xB9), dispatches a tracked press/release to that registration, processes the hotkey, and requests Revit focus again. This follows Microsoft's [UI Automation focus implementation](https://raw.githubusercontent.com/dotnet/wpf/main/src/Microsoft.DotNet.Wpf/src/UIAutomation/UIAutomationClientSideProviders/MS/Internal/AutomationProxies/Misc.cs). Held human input is rejected; Stop and partial-insertion handling use the same policy as other input. The start response reports `focusMethod` (`already-foreground`, `direct`, or `registered-hotkey`).

The helper caches the largest visible unowned Revit window without TOOLWINDOW/NOACTIVATE styles at construction. This is a root-selection heuristic; it stops if the cached HWND loses its bound PID. Repeatedly using `Process.MainWindowHandle` was observed selecting a tooltip after a ViewCube click. Auxiliary windows are excluded from control targets and window-change signatures except for the validated native menus and WPF popups described above. Keyboard navigation can operate menus while their owning Revit window retains focus.

Live validation on 2026-09-14 exercised the same helper across turns: after foreground input in T3 chat, the `registered-hotkey` fallback returned an actionable Revit screenshot. A production DesktopController/DesktopClient harness used clicks and keyboard menu navigation to change the open model's 3D view to Top and Wireframe, then visually verified the result. No model geometry or API mutation was performed. The installed chat process still had its old helper loaded; a complete model-driven chat retest requires reloading the rebuilt package.

Use `--repeat` with `scripts/smoke-desktop-focus.mjs` to check a second turn with the same helper, switching to chat during the five-second pause. A fresh-helper-only smoke is insufficient to verify background focus permission.

The helper is now bundled and launched on demand by the host, with `revit_ui_observe` and `revit_ui_action` registered in Pi. The integration is experimental. The user reports testing computer use; that report predates the input-monitor and static-notice changes and does not establish coverage of those changes. No Revit API assemblies or automation framework are loaded in the helper. The standalone driver below remains available for isolated manual checks.

## Host and agent integration

The Revit launcher passes PID, exact UTC process-start ticks, and the packaged helper path to Node. Node launches the helper hidden, verifies its own start identity, and holds one helper generation for the host lifetime. It never silently restarts a disconnected helper. Each agent turn gets typed desktop callbacks bound to its active document and cancellation signal. The first observation shows a three-second countdown before acquiring input ownership, waiting for quiet input, restoring a minimized Revit window, and activating its enabled main window or owned dialog. Each restore/activation request waits up to two seconds for the asynchronous transition, processing Stop while waiting; completion, Stop, focus/lease loss or document change ends the workflow. The selected model must accept images before either desktop tool can run. Both observation and post-action results carry actual Pi image content blocks.

Host desktop requests are mutually exclusive with API dispatch. API-pending and native/desktop unknown states block desktop mutation; desktop unknown also blocks API mutation. A separate authenticated `POST /api/desktop/observe` route remains available for passive recovery screenshots. `POST /api/desktop/stop` and normal cancellation bypass the mutation queue. `GET /api/desktop/image/<artifact>` requires the browser bearer token and serves only the latest retained PNG. Browser snapshot state includes control status, image metadata and recent action receipts, never image bytes or credentials.

`desktop/journal.json` stores up to 1000 action intents and receipts per host instance. Intent is persisted before dispatch; same-ID retries return the existing receipt, changed payloads are rejected, and unknown intents survive host restart as a fence. The helper receives a host-generated operation ID, not a model-selected PID or generation. Only the latest PNG is retained under `desktop/`; a new capture deletes its predecessor, and restart removes stale images. Prior-turn images do not authorize actions; the agent must capture again. New Pi sessions are in-memory, so full image tool results are not also appended to session files. Existing session logs from earlier versions are not deleted. Desktop evidence includes the cached native context and its acquisition time/age; native heartbeats do not prove that cache is fresh while Idling is blocked. Document switching is unsupported during a desktop workflow, and the token guard is best effort rather than an atomic active-document boundary.

For the installed workflow use `pnpm run build:install`, reopen Revit and chat with an image-capable model. The standalone driver's exact-image-match staging described below applies only to manual tests; the agent chooses targets directly from fresh tool images.

Build a self-contained helper independently of Revit's runtime:

```powershell
pnpm run build:host
dotnet publish dotnet/Revcode.Desktop/Revcode.Desktop.csproj -c Release -r win-x64 --self-contained true -o artifacts/desktop-spike
node scripts/desktop-spike.mjs artifacts/desktop-spike/Revcode.Desktop.exe <Revit-PID> artifacts/desktop-evidence --enable-input
```

Use a disposable Revit project with no active API operation. The driver uses the production DesktopClient and DesktopController, including their heartbeat, recovery, durable action journal and unknown-outcome fences; it writes review metadata and PNG artifacts to a **new** evidence directory. Omit `--enable-input` for passive capture only. The helper itself takes Revit PID, Revit UTC start ticks, parent PID, parent UTC start ticks, and optionally `--enable-input`. Start identities are decimal strings on the command line, preserving 64-bit precision. The parent must keep the pipe open and send heartbeats. Normal integrity and an active, unlocked Windows session are required. Console and connected Remote Desktop sessions are allowed; disconnected sessions, inaccessible input desktops, and locked/secure desktops are rejected. The helper checks WTS connection state and matches its desktop to the input desktop without switching desktops. If Remote Desktop Services is unavailable, only a session attached to the physical console may pass the connection check.

## Manual staged testing

The driver accepts `observe`, `action`, and `stop` commands. It manages helper start/stop and observation IDs; do not enter raw `start` requests in the driver.

1. Enter `{"kind":"observe","delaySeconds":5}`. Activate Revit during those five seconds, then release the mouse and keyboard. The driver captures and releases control automatically.
2. Return to the terminal and review the saved PNG. Choose the target from that image.
3. Enter, for example, `{"kind":"action","action":"click","x":100,"y":100,"delaySeconds":5}` with the actual image coordinates. Activate Revit again during the delay and release all input.
4. The driver reacquires control and captures a fresh frame. It sends the action using that new observation ID **only if the PNG hash, window identity, dialog set, crop, dimensions, bounds, and DPI match the reviewed evidence**. It captures afterward and releases control again.

The manual staging delay is three seconds, configurable from 1–30, followed by the production three-second control countdown. Type `{"kind":"stop"}` at any time, including during staging; the driver reads Stop independently of pending work and bypasses journal writes for cancellation. Ctrl+Alt+F12 also stops the helper while its input lease is active. Staging itself holds no input lease. End-of-input cancels pending staging and closes the helper pipe.

A changed image refuses the action and saves the new PNG for review. There is no automatic retry. Exact PNG equality is deliberately conservative: caret blinking, hover effects, animation, window changes, or a changed Revit tab can cause refusal. Review the newest PNG before explicitly submitting again. This check does not establish general visual targeting reliability. Passive capture without `--enable-input` remains available but cannot authorize actions. The driver's saved screenshots are review references after it releases control, never reusable actionable helper observations.

## Helper wire contract

The transport is inherited UTF-8 stdin/stdout, one JSON object per line. Diagnostics go to stderr. Requests are limited to 16 KiB, eight queued requests, and protocol version 1. Malformed framing closes the helper and releases its lease. Responses contain `version`, `requestId`, `generation`, `unknown`, `result`, and `error`. `unknown: true` reports native input uncertainty, including partial focus-activation input, even on an error response. The host persists this fence independently of action entries; a generic transport exit is not proof of native input uncertainty. Clients must keep reading stdout; backpressure beyond eight responses shuts down the helper. No TCP listener or credentials are needed.

| Kind | Fields/behavior |
| --- | --- |
| `hello` | Returns generation, capture backend, and input configuration. |
| `heartbeat` | Requires current generation; refreshes 10-second watchdog. |
| `start` | Requires current generation and input flag. Acquires a user/session mutex and Ctrl+Alt+F12 hotkey, attempts foreground activation once; fails and releases ownership if refused. Explicitly start again after activating Revit. |
| `stop` | Works without a generation. Cancels future input, releases helper-held keys/buttons and mutex. Does not undo or terminate Revit. |
| `observe` | Optional opaque `windowRef`, window-relative physical `crop: {x,y,width,height}`, and `maxWidth` (64–2048, default 1600). Passive; never activates a window. |
| `action` | Requires generation, fresh `observationId`, and one `action` below. Returns a dispatch receipt. The production controller captures afterward. |

Every request includes `version: 1`, a unique `requestId` (1–80 characters), and, except hello/Stop, the current `generation`. Request IDs for **actions** are deduplicated: identical requests retrieve the retained receipt; changed payloads are rejected. The 1024-entry in-memory ledger refuses further actions instead of evicting IDs. It does not survive a crash. A new helper rejects old-generation requests; the durable driver's journal must be inspected after a crash or timeout. Never construct a fresh ID to retry an uncertain action.

Actions:

- `move` and `click`: finite `x`, `y` in the supplied image. Click is one left-button click.
- `scroll`: image `x`, `y`, `direction` (`up`, `down`, `left`, `right`) and `notches` (1–10); one notch is 120 wheel units.
- `type`: `text`, 1–1024 UTF-16 units, no control characters or unpaired surrogates. Emits Unicode scalars in cancellable batches, preserving surrogate pairs. Does not use the clipboard.
- `key`: `keys`, 1–3 distinct names from CTRL, SHIFT, ALT, ENTER, TAB, ESC, BACKSPACE, DELETE, HOME, END, LEFT, UP, RIGHT, DOWN, A, F. Each chord includes releases. No persistent key holds or drag.

Observation returns PNG base64 in `data` with `mimeType: image/png` (maximum 8 MiB encoded source bytes, 4 million output pixels, 16 million captured pixels), UTC acquisition timestamp, dimensions, physical window bounds, physical crop bounds, DPI, opaque foreground reference, and enumerated main/owned top-level windows. Resizing maps image coordinates through the physical crop. Negative desktop origins and virtual-desktop normalization are supported. The driver replaces bytes with an artifact filename in its durable journal. It never sends screenshots to a provider. Evidence is retained until the tester removes the directory; no unattended artifact accumulation is enabled.

An observation is actionable only with the input lease, foreground ownership, matching window geometry/dialog set, and no held input. Each action consumes its observation; expiry is 15 seconds. Revalidate after pumping messages and immediately before each batch; pointer targets repeat hit-testing at that point. Cursor movement, held keys/buttons, or focus outside the bound Revit window/owner chain revoke the screenshot and request bounded input recovery without releasing the lease. Input cannot resume until Revit is foreground and a new actionable screenshot is obtained after quiet input. Focus passing between Revit and its owned dialogs invalidates the old observation while retaining the lease; obtain a new screenshot before further input. Geometry or dialog changes still reject an action based on the old image. Detection is best effort: desktop input is not atomic against the user. Input is bounded by 10-second heartbeat and two-minute action inactivity timeouts, including model-thinking intervals. Heartbeats include an optional `error` describing why the watchdog stopped, preserved until the next start. Stop is signaled from the pipe reader independently of pending capture; the message loop handles the desktop hotkey and releases ownership. Already inserted events cannot be recalled, and synchronous screen capture may delay hotkey handling until it returns.

Pi can report cancellation in an assistant `message_end` event while resolving `prompt()` normally. The agent adapter propagates the terminal error to the host, and the host checks its turn cancellation signal even after normal completion. A desktop interruption therefore appears in the conversation with its local reason instead of only the provider's generic “Request was aborted”. A subsequent successful provider retry clears an earlier error.

Observations include `owned`, optional `recovery: "observe"`, and a `reason` when non-actionable. Receipts include current `owned` and optional `recovery: "observe"` for a confirmed zero-input frame refusal. The host makes at most three captures per observation request, 150 ms apart, only for explicitly recoverable frames with retained ownership. It never resends actions. The agent may request at most two additional observations before stopping. Stale frames still expire after 15 seconds; refreshing them does not reacquire focus or extend the two-minute input inactivity limit. The interference watchdog remains active between frames and checks focus and held keys/buttons before and after capture. Cursor motion alone retains ownership: each actionable capture establishes a new cursor baseline, motion during capture requests another observation, and motion before dispatch refuses input with recovery: "observe". Cursor changes after partial dispatch still produce an unknown outcome and must never be replayed. Stop invalidates pending client launch/start requests and native starts queued before Stop was parsed. The native policy checks the queued cancellation generation atomically when resuming; explicit starts received after Stop can resume normally. Idle helper failures update availability without interrupting unrelated API turns.

Receipts distinguish `dispatched`, `not-dispatched`, and `unknown`, with inserted event counts. Dispatch is not application success. Partial insertion or interruption after input fences further actions for that generation while observation remains available. Input releases are attempted on all stop/error paths; release failure is reported to stderr and keeps the unknown fence. A missing post-action screenshot never changes a dispatch receipt into non-dispatch.

## Capture decision still pending

The implemented backend is **experimental visible-region GDI capture** (`Graphics.CopyFromScreen`), acquired at the timestamp in the observation. It includes whatever is physically displayed in the selected bounds, including occluding windows. Captures of occluded regions are evidence, not proof that Revit received input; target-point validation rejects unrelated top-level windows. Main-window capture can include visible popup pixels but popup targeting outside the selected top-level window is conservatively rejected. Fully offscreen/minimized captures are rejected. Dark or unchanged pixels are not treated as errors.

This is a comparison baseline, not a decision to replace Windows.Graphics.Capture. The HWND WGC implementation and measured comparison against GPU viewports, hover menus and owned dialogs remain pending, as do live mixed-DPI, integrity/focus refusal, Unicode field compatibility, competing-helper, interruption and complete-workflow tests. The installed host supplies document binding and native-operation coordination. The standalone driver has neither: **do not use that driver alongside running API operations**. API-raised dialog service is unsupported in both paths.

The native behavior follows Microsoft's [SendInput contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [virtual-desktop mouse coordinates](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput), and [capture guidance](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture). Those documents do not establish Revit compatibility.

The session gate was checked on an active Windows RDP session on 2026-09-13 and accepted it. Regression tests cover active remote/console sessions, disconnected sessions, console fallback and inaccessible/secure desktops. Subsequent live focus checks brought Revit 2026 Home forward from the T3 chat window and restored it from minimized, obtaining actionable screenshots in both cases. No model-editing input was dispatched. The complete section-view workflow remains unverified.

To repeat the focus check, build the host and helper, leave chat foreground (optionally minimize Revit), and run `node scripts/smoke-desktop-focus.mjs <helper.exe> <Revit-PID> <new-evidence-directory>`. It uses the production host desktop client and controller to run the countdown/recovery path, save one screenshot and release control. Windows may still refuse activation for a blocking menu or inaccessible desktop; refusal is bounded, and input is never dispatched before verified foreground capture. Switching away during a workflow still pauses control.
