# Desktop helper spike protocol

This implements the standalone portion of phase 1 of [the desktop plan](DESKTOP-UI-PLAN.md). It is experimental and is not registered with Pi or launched by the production host. Model-driven desktop actions remain gated on live Revit evidence. No Revit API assemblies or automation framework are loaded.

Build a self-contained helper independently of Revit's runtime:

```powershell
dotnet publish dotnet/Revcode.Desktop/Revcode.Desktop.csproj -c Release -r win-x64 --self-contained true -o artifacts/desktop-spike
node scripts/desktop-spike.mjs artifacts/desktop-spike/Revcode.Desktop.exe <Revit-PID> artifacts/desktop-evidence --enable-input
```

Use a disposable Revit project with no active API operation. The driver records intent and flushes it to disk before dispatch; it writes responses and PNG artifacts to a **new** evidence directory. Omit `--enable-input` for passive capture only. The helper itself takes Revit PID, Revit UTC start ticks, parent PID, parent UTC start ticks, and optionally `--enable-input`. Start identities are decimal strings on the command line, preserving 64-bit precision. The parent must keep the pipe open and send heartbeats. Normal integrity and a local, unlocked session are required. Remote desktop sessions are conservatively rejected for this spike.

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

An observation is actionable only with the input lease, foreground ownership, matching window geometry/dialog set, and no held input. Each action consumes its observation; expiry is 15 seconds. Revalidate before each batch; pointer targets also check the topmost window at the physical target. Cursor movement, held keys/buttons, changed focus, geometry, or dialogs pause control. Detection is best effort: desktop input is not atomic against the user. Input is bounded by 10-second heartbeat and two-minute action inactivity timeouts, including model-thinking intervals in future clients. Stop is signaled from the pipe reader independently of pending capture; the message loop handles the desktop hotkey and releases ownership. Already inserted events cannot be recalled, and synchronous screen capture may delay hotkey handling until it returns.

Receipts distinguish `dispatched`, `not-dispatched`, and `unknown`, with inserted event counts. Dispatch is not application success. Partial insertion or interruption after input fences further actions for that generation while observation remains available. Input releases are attempted on all stop/error paths; release failure is reported to stderr and keeps the unknown fence. A missing post-action screenshot never changes a dispatch receipt into non-dispatch.

## Capture decision still pending

The implemented backend is **experimental visible-region GDI capture** (`Graphics.CopyFromScreen`), acquired at the timestamp in the observation. It includes whatever is physically displayed in the selected bounds, including occluding windows. Captures of occluded regions are evidence, not proof that Revit received input; target-point validation rejects unrelated top-level windows. Main-window capture can include visible popup pixels but popup targeting outside the selected top-level window is conservatively rejected. Fully offscreen/minimized captures are rejected. Dark or unchanged pixels are not treated as errors.

This is a comparison baseline, not a decision to replace Windows.Graphics.Capture. The HWND WGC implementation and measured comparison against GPU viewports, hover menus and owned dialogs are still required before selecting the production backend. Live mixed-DPI, integrity/focus refusal, Unicode field compatibility, competing helpers, interruption, and workflow tests are also pending. The spike has no document-token knowledge or native-operation scheduler; **do not use it alongside running API operations**. Host coordination, browser evidence, provider image delivery, production packaging, and API-raised dialog service belong to subsequent gated phases.

The native behavior follows Microsoft's [SendInput contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [virtual-desktop mouse coordinates](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput), and [capture guidance](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture). Those documents do not establish Revit compatibility.
