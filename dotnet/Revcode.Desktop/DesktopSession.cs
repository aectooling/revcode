using System.Diagnostics;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Revcode.Desktop;

internal sealed record WindowInfo(string WindowRef, string Title, Bounds Bounds, uint Dpi);
internal sealed record Observation(string ObservationId, string Timestamp, string WindowRef, string Title,
    Bounds Bounds, Bounds Crop, int Width, int Height, uint Dpi, string? ForegroundWindowRef,
    WindowInfo[] Windows, bool Actionable, string Backend, string MimeType, string Data);

internal sealed class DesktopSession : IDisposable
{
    private static readonly IReadOnlyDictionary<string, ushort> AllowedKeys = new Dictionary<string, ushort>
    {
        ["CTRL"] = 17, ["SHIFT"] = 16, ["ALT"] = 18,
        ["ENTER"] = 13, ["TAB"] = 9, ["ESC"] = 27,
        ["BACKSPACE"] = 8, ["DELETE"] = 46,
        ["HOME"] = 36, ["END"] = 35,
        ["LEFT"] = 37, ["UP"] = 38, ["RIGHT"] = 39, ["DOWN"] = 40,
        ["A"] = 65, ["F"] = 70,
    };
    private readonly Process target, parent;
    private readonly long targetStart, parentStart;
    private readonly bool inputEnabled;
    private readonly Mutex lease;
    private readonly Dictionary<nint, string> windowRefs = new();
    private readonly DispatchLedger ledger = new();
    private readonly Stopwatch heartbeat = Stopwatch.StartNew(), inactivity = Stopwatch.StartNew();
    private readonly Stopwatch frameAge = Stopwatch.StartNew();
    private readonly HashSet<(ushort Key, bool Unicode)> heldKeys = new();
    private bool heldButton, owned, hotkey;
    private readonly InputPolicy policy = new();
    private Observation? observation;
    private nint observationWindow;
    private Win32.Point cursor;
    private string windowsSignature = "";
    private readonly nint messageWindow;
    public string Generation { get; } = Guid.NewGuid().ToString("N");
    public void RequestStop() => policy.Stop();
    private bool LeaseReady => policy.LeaseReady(owned, heartbeat.Elapsed, inactivity.Elapsed);
    private bool Interference => Win32.GetForegroundWindow() != observationWindow ||
        !Win32.GetCursorPos(out var point) || point.X != cursor.X || point.Y != cursor.Y || HumanHeldInput();

    public DesktopSession(int targetPid, long startTicks, int parentPid, long parentTicks, bool enableInput, nint messageWindow)
    {
        target = Process.GetProcessById(targetPid); parent = Process.GetProcessById(parentPid);
        targetStart = startTicks; parentStart = parentTicks; inputEnabled = enableInput; this.messageWindow = messageWindow;
        if (!string.Equals(target.ProcessName, "Revit", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Target must be Revit.");
        CheckIdentity();
        using var identity = WindowsIdentity.GetCurrent();
        lease = new Mutex(false, $@"Local\Revcode.Desktop.{identity.User!.Value}.{target.SessionId}");
    }

    private void CheckIdentity()
    {
        if (target.HasExited || parent.HasExited || target.StartTime.ToUniversalTime().Ticks != targetStart || parent.StartTime.ToUniversalTime().Ticks != parentStart || target.SessionId != Process.GetCurrentProcess().SessionId)
            throw new InvalidOperationException("Bound process exited or its identity/session changed.");
    }

    public void Tick()
    {
        try { CheckIdentity(); } catch { Stop(); Application.ExitThread(); return; }
        if (owned && (!LeaseReady || (observation != null && Interference))) Stop();
    }

    private WindowInfo[] Windows()
    {
        CheckIdentity(); target.Refresh(); var main = target.MainWindowHandle;
        var result = new List<WindowInfo>();
        Win32.EnumWindows((window, _) =>
        {
            if (Win32.Pid(window) != target.Id || !Win32.IsWindowVisible(window)) return true;
            // Restrict top-level windows to Revit's main window and its owner chain.
            var owner = window;
            for (var i = 0; i < 32 && owner != 0 && owner != main; i++) owner = Win32.GetWindow(owner, Win32.WindowOwner);
            if (main == 0 || owner != main) return true;
            if (!windowRefs.TryGetValue(window, out var reference)) windowRefs[window] = reference = Guid.NewGuid().ToString("N");
            result.Add(new(reference, Win32.Title(window), Win32.Geometry(window), Win32.GetDpiForWindow(window)));
            return true;
        }, 0);
        return result.ToArray();
    }

    private static string Signature(WindowInfo[] windows) => System.Text.Json.JsonSerializer.Serialize(windows.OrderBy(w => w.WindowRef));
    private nint Resolve(string reference, WindowInfo[] windows)
    {
        if (!windows.Any(w => w.WindowRef == reference)) throw new InvalidOperationException("Window is no longer available.");
        return windowRefs.Single(pair => pair.Value == reference).Key;
    }

    public object Handle(Request request)
    {
        if (request.Version != 1 || string.IsNullOrWhiteSpace(request.RequestId) || request.RequestId.Length > 80) throw new ArgumentException("Invalid protocol version or request ID.");
        if (request.Kind == "hello") return new { generation = Generation, inputEnabled, backend = "experimental-visible-gdi", maxRequestBytes = 16384, emergencyStop = "Ctrl+Alt+F12" };
        if (request.Kind == "stop") { Stop(); return new { status = "stopped", unknown = policy.Unknown }; }
        if (request.Generation != Generation) throw new InvalidOperationException("Helper generation changed; inspect before starting new work. Never replay old input.");
        CheckIdentity();
        switch (request.Kind)
        {
            case "heartbeat": heartbeat.Restart(); return new { owned, unknown = policy.Unknown };
            case "start": return Start();
            case "observe": return Observe(request);
            case "action": return Act(request);
            default: throw new ArgumentException("Unknown request kind.");
        }
    }

    private object Start()
    {
        if (!inputEnabled) throw new InvalidOperationException("Desktop input requires --enable-input.");
        if (owned) return new { status = "owned" };
        policy.Resume();
        if (!Win32.Interactive()) throw new InvalidOperationException("Desktop control requires an active, unlocked Windows session. Unlock or reconnect the session running Revit (console or Remote Desktop).");
        using var self = Process.GetCurrentProcess();
        if (Win32.Integrity(target) != Win32.Integrity(self)) throw new InvalidOperationException("Target integrity differs from helper; elevation is not attempted.");
        try { owned = lease.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
        if (!owned) throw new InvalidOperationException("Another Revcode host owns desktop input.");
        try
        {
            hotkey = Win32.RegisterHotKey(messageWindow, 1, Win32.HotkeyControlAltNoRepeat, Win32.KeyF12);
            if (!hotkey) throw new InvalidOperationException("Could not register Ctrl+Alt+F12 emergency Stop.");
            heartbeat.Restart(); inactivity.Restart(); observation = null;
            target.Refresh(); var main = target.MainWindowHandle;
            if (main == 0) throw new InvalidOperationException("No Revit window.");
            if (Win32.IsIconic(main)) WaitForFocus(main, () => Win32.ShowWindowAsync(main, 9), () => !Win32.IsIconic(main));
            var windows = Windows(); var foreground = Win32.GetForegroundWindow();
            var popup = Win32.GetLastActivePopup(main);
            var enabled = windows.Where(w => Win32.IsWindowEnabled(Resolve(w.WindowRef, windows))).ToArray();
            var selected = enabled.FirstOrDefault(w => Resolve(w.WindowRef, windows) == foreground)
                ?? enabled.FirstOrDefault(w => Resolve(w.WindowRef, windows) == popup)
                ?? enabled.FirstOrDefault() ?? throw new InvalidOperationException("No enabled Revit window. Close the blocking dialog and retry.");
            var window = Resolve(selected.WindowRef, windows);
            WaitForFocus(window, () => Win32.SetForegroundWindow(window), () => Win32.GetForegroundWindow() == window && !Win32.IsIconic(window) && Win32.IsWindowEnabled(window));
            return new { status = "owned" };
        }
        catch { Stop(); throw; }
    }

    private void WaitForFocus(nint window, Action request, Func<bool> ready)
    {
        var elapsed = Stopwatch.StartNew();
        FocusHandoff.Run(request, ready, () =>
        {
            CheckIdentity();
            if (!LeaseReady) throw new InvalidOperationException("Desktop activation stopped.");
            if (!Win32.Interactive() || Win32.Pid(window) != target.Id || HumanHeldInput())
                throw new InvalidOperationException("Desktop or input changed while activating Revit. Retry after releasing held keys/buttons.");
        }, Application.DoEvents, () => Thread.Sleep(25), () => elapsed.Elapsed >= TimeSpan.FromSeconds(2));
    }

    private Observation Observe(Request request)
    {
        observation = null;
        if (!Win32.Interactive()) throw new InvalidOperationException("Capture requires an active, unlocked Windows session. Unlock or reconnect the session running Revit (console or Remote Desktop).");
        var windows = Windows();
        var foreground = Win32.GetForegroundWindow();
        var selected = request.WindowRef != null ? windows.SingleOrDefault(w => w.WindowRef == request.WindowRef) : windows.FirstOrDefault(w => Resolve(w.WindowRef, windows) == foreground) ?? windows.LastOrDefault();
        if (selected == null) throw new InvalidOperationException("No bound visible window.");
        var window = Resolve(selected.WindowRef, windows);
        if (Win32.IsIconic(window)) throw new InvalidOperationException("Cannot capture a minimized window.");
        var bounds = selected.Bounds;
        var crop = request.Crop ?? new Bounds(0, 0, bounds.Width, bounds.Height);
        if (crop.Width < 1 || crop.Height < 1 || crop.X < 0 || crop.Y < 0 || (long)crop.X + crop.Width > bounds.Width || (long)crop.Y + crop.Height > bounds.Height || (long)crop.Width * crop.Height > 16_000_000 || request.MaxWidth < 64 || request.MaxWidth > 2048)
            throw new ArgumentException("Invalid crop/size; maximum 16 million source pixels and 2048 output width.");
        var physical = new Bounds(checked(bounds.X + crop.X), checked(bounds.Y + crop.Y), crop.Width, crop.Height);
        var desktop = Win32.Desktop;
        if (!desktop.Contains(physical.X, physical.Y) || !desktop.Contains(physical.X + physical.Width - 1, physical.Y + physical.Height - 1)) throw new InvalidOperationException("Capture extends outside desktop.");
        var width = Math.Min(request.MaxWidth, crop.Width); var height = Math.Max(1, (int)((long)crop.Height * width / crop.Width));
        if ((long)width * height > 4_000_000) throw new ArgumentException("Output exceeds four million pixels.");
        using var source = new Bitmap(crop.Width, crop.Height);
        frameAge.Restart();
        var timestamp = DateTimeOffset.UtcNow;
        using (var graphics = Graphics.FromImage(source)) graphics.CopyFromScreen(physical.X, physical.Y, 0, 0, source.Size, CopyPixelOperation.SourceCopy);
        using var resized = new Bitmap(source, new Size(width, height)); using var stream = new MemoryStream(); resized.Save(stream, ImageFormat.Png);
        if (stream.Length > 8 * 1024 * 1024) throw new InvalidOperationException("PNG exceeds 8 MiB.");
        var currentWindows = Windows();
        var actionable = LeaseReady && Win32.GetForegroundWindow() == window && foreground == window && Win32.IsWindowEnabled(window) && Signature(currentWindows) == Signature(windows) && !HumanHeldInput();
        var result = new Observation(Guid.NewGuid().ToString("N"), timestamp.ToString("O"), selected.WindowRef, selected.Title,
            bounds, physical, width, height, selected.Dpi, windows.FirstOrDefault(w => Resolve(w.WindowRef, windows) == foreground)?.WindowRef,
            windows, actionable, "experimental-visible-gdi", "image/png", Convert.ToBase64String(stream.ToArray()));
        if (actionable)
        {
            observation = result; observationWindow = window; windowsSignature = Signature(windows); Win32.GetCursorPos(out cursor);
        }
        return result;
    }

    private static bool HumanHeldInput()
    {
        // Refuse any human-held key/button, including modifiers and mouse buttons.
        for (var key = 1; key < 255; key++) if ((Win32.GetAsyncKeyState(key) & 0x8000) != 0) return true;
        return false;
    }

    private void ValidateObservation(Request request, Observation frame)
    {
        CheckIdentity();
        policy.RequireObservation(LeaseReady, frame.Actionable, request.ObservationId, frame.ObservationId, frameAge.Elapsed);
        if (!Win32.Interactive() || Win32.IsIconic(observationWindow) || !Win32.IsWindowEnabled(observationWindow) || Win32.GetForegroundWindow() != observationWindow || Win32.Geometry(observationWindow) != frame.Bounds || Signature(Windows()) != windowsSignature || Win32.GetDpiForWindow(observationWindow) != frame.Dpi)
            throw new InvalidOperationException("Focus, window geometry, or dialogs changed. Observe again.");
        if (Interference) throw new InvalidOperationException("Human input detected. Control paused.");
        if (request.Action is "move" or "click" or "scroll")
        {
            var (x, y) = Coordinates.Map(frame.Crop, frame.Width, frame.Height,
                request.X ?? throw new ArgumentException("Pointer actions require x."),
                request.Y ?? throw new ArgumentException("Pointer actions require y."));
            if (Win32.GetAncestor(Win32.WindowFromPoint(new() { X = x, Y = y }), Win32.RootAncestor) != observationWindow)
                throw new InvalidOperationException("Target point is occluded by another window.");
        }
    }

    private Receipt Act(Request request)
    {
        var old = ledger.Find(request); if (old != null) return old;
        if (observation == null) throw new InvalidOperationException("Observe before each action.");
        var frame = observation;
        var desktop = Win32.Desktop;
        List<Win32.Input[]> batches;
        try { ValidateObservation(request, frame); batches = BuildInput(request, frame); }
        catch { Stop(); throw; }
        ledger.Begin(request); observation = null;
        var receipt = InputDispatch.Run(batches, Application.DoEvents, () =>
            {
                if (Win32.Desktop != desktop) throw new InvalidOperationException("Monitor layout changed. Observe again.");
                ValidateObservation(request, frame);
            },
            batch => (int)Win32.SendInput((uint)batch.Length, batch, Marshal.SizeOf<Win32.Input>()),
            (batch, count) => { TrackInserted(batch, count); Win32.GetCursorPos(out cursor); });
        if (receipt.Status == "unknown") policy.MarkUnknown();
        ledger.Complete(request, receipt);
        if (receipt.Status == "dispatched") inactivity.Restart();
        else Stop();
        return receipt;
    }

    private List<Win32.Input[]> BuildInput(Request request, Observation frame)
    {
        var batches = new List<Win32.Input[]>();
        if (request.Action is "move" or "click" or "scroll")
        {
            if (request.X == null || request.Y == null) throw new ArgumentException("Pointer actions require image coordinates.");
            var (x, y) = Coordinates.Map(frame.Crop, frame.Width, frame.Height, request.X.Value, request.Y.Value);
            var (nx, ny) = Coordinates.Normalize(Win32.Desktop, x, y);
            var events = new List<Win32.Input> { Win32.MouseEvent(Win32.AbsoluteVirtualMove, nx, ny) };
            if (request.Action == "click")
            {
                events.Add(Win32.MouseEvent(Win32.LeftDown));
                events.Add(Win32.MouseEvent(Win32.LeftUp));
            }
            if (request.Action == "scroll")
            {
                if (request.Notches is not (>= 1 and <= 10) || request.Direction is not ("up" or "down" or "left" or "right")) throw new ArgumentException("Scroll needs direction and 1–10 wheel notches.");
                var delta = request.Notches.Value * Win32.WheelDelta * (request.Direction is "down" or "left" ? -1 : 1);
                events.Add(Win32.MouseEvent(request.Direction is "left" or "right" ? Win32.HorizontalWheel : Win32.VerticalWheel, data: unchecked((uint)delta)));
            }
            batches.Add(events.ToArray());
        }
        else if (request.Action == "type")
        {
            if (string.IsNullOrEmpty(request.Text) || request.Text.Length > 1024 || request.Text.Any(char.IsControl)) throw new ArgumentException("Type accepts 1–1024 printable UTF-16 units; use keys for controls.");
            // Strict validation rejects unpaired surrogates. Keep each Unicode scalar in one batch.
            _ = new System.Text.UTF8Encoding(false, true).GetBytes(request.Text);
            foreach (var rune in request.Text.EnumerateRunes()) batches.Add(rune.ToString().SelectMany(c => new[] { Win32.KeyEvent(c, false, true), Win32.KeyEvent(c, true, true) }).ToArray());
        }
        else if (request.Action == "key")
        {
            if (request.Keys is not { Length: >= 1 and <= 3 } ||
                request.Keys.Distinct().Count() != request.Keys.Length ||
                request.Keys.Any(k => k == null || !AllowedKeys.ContainsKey(k)))
                throw new ArgumentException("Unsupported key chord.");
            batches.Add(request.Keys.Select(k => Win32.KeyEvent(AllowedKeys[k], false))
                .Concat(request.Keys.Reverse().Select(k => Win32.KeyEvent(AllowedKeys[k], true))).ToArray());
        }
        else throw new ArgumentException("Action must be move, click, scroll, type or key.");
        return batches;
    }

    private void TrackInserted(Win32.Input[] batch, int count)
    {
        foreach (var input in batch.Take(count))
        {
            if (input.Type == Win32.KeyboardInput)
            {
                var key = input.Data.Keyboard;
                var unicode = (key.Flags & Win32.UnicodeKey) != 0;
                var identity = (unicode ? key.Scan : key.Key, unicode);
                if ((key.Flags & Win32.KeyUp) != 0) heldKeys.Remove(identity);
                else heldKeys.Add(identity);
            }
            else
            {
                if ((input.Data.Mouse.Flags & Win32.LeftDown) != 0) heldButton = true;
                if ((input.Data.Mouse.Flags & Win32.LeftUp) != 0) heldButton = false;
            }
        }
    }

    public void Stop()
    {
        policy.Stop();
        observation = null;
        var releases = heldKeys.Select(k => Win32.KeyEvent(k.Key, true, k.Unicode)).ToList();
        if (heldButton) releases.Add(Win32.MouseEvent(Win32.LeftUp));
        if (releases.Count > 0)
        {
            var batch = releases.ToArray(); var count = Win32.SendInput((uint)batch.Length, batch, Marshal.SizeOf<Win32.Input>());
            TrackInserted(batch, (int)count);
            if (count != batch.Length)
            {
                policy.MarkUnknown();
                Console.Error.WriteLine("Input release incomplete. Manually release keys/buttons before continuing.");
            }
        }
        if (hotkey) { Win32.UnregisterHotKey(messageWindow, 1); hotkey = false; }
        if (owned) { lease.ReleaseMutex(); owned = false; }
    }

    public void Dispose() { Stop(); lease.Dispose(); target.Dispose(); parent.Dispose(); }
}
