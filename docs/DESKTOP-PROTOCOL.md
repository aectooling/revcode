# Desktop helper spike protocol

The helper is now bundled and launched on demand by the host, with `revit_ui_observe` and `revit_ui_action` registered in Pi. The integration is experimental; live Revit acceptance remains pending. No Revit API assemblies or automation framework are loaded in the helper. The standalone driver below remains available for isolated manual checks.

## Host and agent integration

The Revit launcher passes PID, exact UTC process-start ticks, and the packaged helper path to Node. Node launches the helper hidden, verifies its own start identity, and holds one helper generation for the host lifetime. It never silently restarts a disconnected helper. Each agent turn gets typed desktop callbacks bound to its active document and cancellation signal. The first observation acquires input ownership and attempts focus once; completion, Stop, focus/lease loss or document change ends the workflow. The selected model must accept images before either desktop tool can run. Both observation and post-action results carry actual Pi image content blocks.

Host desktop requests are mutually exclusive with API dispatch. API-pending and native/desktop unknown states block desktop mutation; desktop unknown also blocks API mutation. A separate authenticated `POST /api/desktop/observe` route remains available for passive recovery screenshots. `POST /api/desktop/stop` and normal cancellation bypass the mutation queue. `GET /api/desktop/image/<artifact>` requires the browser bearer token and serves only the latest retained PNG. Browser snapshot state includes control status, image metadata and recent action receipts, never image bytes or credentials.

`desktop/journal.json` stores up to 1000 action intents and receipts per host instance. Intent is persisted before dispatch; same-ID retries return the existing receipt, changed payloads are rejected, and unknown intents survive host restart as a fence. The helper receives a host-generated operation ID, not a model-selected PID or generation. Only the latest PNG is retained under `desktop/`; a new capture deletes its predecessor, and restart removes stale images. Prior-turn images do not authorize actions; the agent must capture again. New Pi sessions are in-memory, so full image tool results are not also appended to session files. Existing session logs from earlier versions are not deleted. Desktop evidence includes the cached native context and its acquisition time/age; native heartbeats do not prove that cache is fresh while Idling is blocked. Document switching is unsupported during a desktop workflow, and the token guard is best effort rather than an atomic active-document boundary.

For the installed workflow use `npm run build:install`, reopen Revit and chat with an image-capable model. The standalone driver's exact-image-match staging described below applies only to manual tests; the agent chooses targets directly from fresh tool images.

Build a self-contained helper independently of Revit's runtime:

```powershell
dotnet publish dotnet/Revcode.Desktop/Revcode.Desktop.csproj -c Release -r win-x64 --self-contained true -o artifacts/desktop-spike
node scripts/desktop-spike.mjs artifacts/desktop-spike/Revcode.Desktop.exe <Revit-PID> artifacts/desktop-evidence --enable-input
```

Use a disposable Revit project with no active API operation. The driver records intent and flushes it to disk before dispatch; it writes responses and PNG artifacts to a **new** evidence directory. Omit `--enable-input` for passive capture only. The helper itself takes Revit PID, Revit UTC start ticks, parent PID, parent UTC start ticks, and optionally `--enable-input`. Start identities are decimal strings on the command line, preserving 64-bit precision. The parent must keep the pipe open and send heartbeats. Normal integrity and an active, unlocked Windows session are required. Console and connected Remote Desktop sessions are allowed; disconnected sessions, inaccessible input desktops, and locked/secure desktops are rejected. The helper checks WTS connection state and matches its desktop to the input desktop without switching desktops. If Remote Desktop Services is unavailable, only a session attached to the physical console may pass the connection check.

## Manual staged testing

The driver accepts `observe`, `action`, and `stop` commands. It manages helper start/stop and observation IDs; do not enter raw `start` requests in the driver.

1. Enter `{"kind":"observe","delaySeconds":5}`. Activate Revit during those five seconds, then release the mouse and keyboard. The driver captures and releases control automatically.
2. Return to the terminal and review the saved PNG. Choose the target from that image.
3. Enter, for example, `{"kind":"action","action":"click","x":100,"y":100,"delaySeconds":5}` with the actual image coordinates. Activate Revit again during the delay and release all input.
4. The driver reacquires control and captures a fresh frame. It sends the action using that new observation ID **only if the PNG hash, window identity, dialog set, crop, dimensions, bounds, and DPI match the reviewed evidence**. It captures afterward and releases control again.

The default delay is three seconds, configurable from 1–30. Type `{"kind":"stop"}` at any time, including during staging; the driver reads Stop independently of pending work and bypasses journal writes for cancellation. Ctrl+Alt+F12 also stops the helper while its input lease is active. Staging itself holds no input lease. End-of-input cancels pending staging and closes the helper pipe.

A changed image refuses the action and saves the new PNG for review. There is no automatic retry. Exact PNG equality is deliberately conservative: caret blinking, hover effects, animation, window changes, or a changed Revit tab can cause refusal. Review the newest PNG before explicitly submitting again. This check does not establish general visual targeting reliability. Passive capture without `--enable-input` remains available but cannot authorize actions. The driver's saved screenshots are review references after it releases control, never reusable actionable helper observations.

## Helper wire contract

The transport is inherited UTF-8 stdin/stdout, one JSON object per line. Diagnostics go to stderr. Requests are limited to 16 KiB, eight queued requests, and protocol version 1. Malformed framing closes the helper and releases its lease. Responses contain `version`, `requestId`, `generation`, `result`, and `error`. Clients must keep reading stdout; backpressure beyond eight responses shuts down the helper. No TCP listener or credentials are needed.

| Kind | Fields/behavior |
| --- | --- |
| `hello` | Returns generation, capture backend, and input configuration. |
| `heartbeat` | Requires current generation; refreshes 10-second watchdog. |
| `start` | Requires current generation and input flag. Acquires a user/session mutex and Ctrl+Alt+F12 hotkey, attempts foreground activation once; fails and releases ownership if refused. Explicitly start again after activating Revit. |
| `stop` | Works without a generation. Cancels future input, releases helper-held keys/buttons and mutex. Does not undo or terminate Revit. |
| `observe` | Optional opaque `windowRef`, window-relative physical `crop: {x,y,width,height}`, and `maxWidth` (64–2048, default 1600). Passive; never activates a window. |
| `action` | Requires generation, fresh `observationId`, and one `action` below. Returns a dispatch receipt. The driver separately captures afterward. |

Every request includes `version: 1`, a unique `requestId` (1–80 characters), and, except hello/Stop, the current `generation`. Request IDs for **actions** are deduplicated: identical requests retrieve the retained receipt; changed payloads are rejected. The 1024-entry in-memory ledger refuses further actions instead of evicting IDs. It does not survive a crash. A new helper rejects old-generation requests; the durable driver's journal must be inspected after a crash or timeout. Never construct a fresh ID to retry an uncertain action.

Actions:

- `move` and `click`: finite `x`, `y` in the supplied image. Click is one left-button click.
- `scroll`: image `x`, `y`, `direction` (`up`, `down`, `left`, `right`) and `notches` (1–10); one notch is 120 wheel units.
- `type`: `text`, 1–1024 UTF-16 units, no control characters or unpaired surrogates. Emits Unicode scalars in cancellable batches, preserving surrogate pairs. Does not use the clipboard.
- `key`: `keys`, 1–3 distinct names from CTRL, SHIFT, ALT, ENTER, TAB, ESC, BACKSPACE, DELETE, HOME, END, LEFT, UP, RIGHT, DOWN, A, F. Each chord includes releases. No persistent key holds or drag.

Observation returns PNG base64 in `data` with `mimeType: image/png` (maximum 8 MiB encoded source bytes, 4 million output pixels, 16 million captured pixels), UTC acquisition timestamp, dimensions, physical window bounds, physical crop bounds, DPI, opaque foreground reference, and enumerated main/owned top-level windows. Resizing maps image coordinates through the physical crop. Negative desktop origins and virtual-desktop normalization are supported. The driver replaces bytes with an artifact filename in its durable journal. It never sends screenshots to a provider. Evidence is retained until the tester removes the directory; no unattended artifact accumulation is enabled.

An observation is actionable only with the input lease, foreground ownership, matching window geometry/dialog set, and no held input. Each action consumes its observation; expiry is 15 seconds. Revalidate after pumping messages and immediately before each batch; pointer targets repeat hit-testing at that point. Cursor movement, held keys/buttons, changed focus, geometry, or dialogs pause control. Detection is best effort: desktop input is not atomic against the user. Input is bounded by 10-second heartbeat and two-minute action inactivity timeouts, including model-thinking intervals in future clients. Stop is signaled from the pipe reader independently of pending capture; the message loop handles the desktop hotkey and releases ownership. Already inserted events cannot be recalled, and synchronous screen capture may delay hotkey handling until it returns.

Receipts distinguish `dispatched`, `not-dispatched`, and `unknown`, with inserted event counts. Dispatch is not application success. Partial insertion or interruption after input fences further actions for that generation while observation remains available. Input releases are attempted on all stop/error paths; release failure is reported to stderr and keeps the unknown fence. A missing post-action screenshot never changes a dispatch receipt into non-dispatch.

## Capture decision still pending

The implemented backend is **experimental visible-region GDI capture** (`Graphics.CopyFromScreen`), acquired at the timestamp in the observation. It includes whatever is physically displayed in the selected bounds, including occluding windows. Captures of occluded regions are evidence, not proof that Revit received input; target-point validation rejects unrelated top-level windows. Main-window capture can include visible popup pixels but popup targeting outside the selected top-level window is conservatively rejected. Fully offscreen/minimized captures are rejected. Dark or unchanged pixels are not treated as errors.

This is a comparison baseline, not a decision to replace Windows.Graphics.Capture. The HWND WGC implementation and measured comparison against GPU viewports, hover menus and owned dialogs remain pending, as do live mixed-DPI, integrity/focus refusal, Unicode field compatibility, competing-helper, interruption and complete-workflow tests. The installed host supplies document binding and native-operation coordination. The standalone driver has neither: **do not use that driver alongside running API operations**. API-raised dialog service is unsupported in both paths.

The native behavior follows Microsoft's [SendInput contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [virtual-desktop mouse coordinates](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput), and [capture guidance](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture). Those documents do not establish Revit compatibility.

The session gate was checked on an active Windows RDP session on 2026-09-13 and accepted it. Regression tests cover active remote/console sessions, disconnected sessions, console fallback and inaccessible/secure desktops. Live Revit screenshot/input and the complete section-view workflow remain unverified; Revit had closed before the live capture check.
