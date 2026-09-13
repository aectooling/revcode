using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Revcode.Desktop;

internal static class Win32
{
    internal const uint RootAncestor = 2;
    internal const uint WindowOwner = 4;
    internal const uint AbsoluteVirtualMove = 0x0001 | 0x4000 | 0x8000;
    internal const uint LeftDown = 0x0002, LeftUp = 0x0004;
    internal const uint VerticalWheel = 0x0800, HorizontalWheel = 0x1000;
    internal const int WheelDelta = 120;
    internal const uint KeyboardInput = 1, ExtendedKey = 1, KeyUp = 2, UnicodeKey = 4;
    internal const uint HotkeyControlAltNoRepeat = 0x0001 | 0x0002 | 0x4000;
    internal const uint KeyF12 = 0x7B;
    // Unassigned virtual key used by Microsoft's UI Automation focus handoff.
    internal const ushort FocusKey = 0xB9;
    internal const int FocusHotkeyId = 2;
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; public readonly Bounds Bounds => new(Left, Top, Right - Left, Bottom - Top); }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct Mouse { public int X, Y; public uint Data, Flags, Time; public nuint Extra; }
    [StructLayout(LayoutKind.Sequential)] internal struct Keyboard { public ushort Key, Scan; public uint Flags, Time; public nuint Extra; }
    [StructLayout(LayoutKind.Explicit)] internal struct InputData { [FieldOffset(0)] public Mouse Mouse; [FieldOffset(0)] public Keyboard Keyboard; }
    [StructLayout(LayoutKind.Sequential)] internal struct Input { public uint Type; public InputData Data; }
    internal delegate bool EnumProc(nint window, nint parameter);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumProc callback, nint parameter);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(nint window, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] internal static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] internal static extern bool IsWindowEnabled(nint window);
    [DllImport("user32.dll")] internal static extern nint GetWindow(nint window, uint command);
    [DllImport("user32.dll")] internal static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(nint window);
    [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(nint window, int command);
    [DllImport("user32.dll")] internal static extern nint GetLastActivePopup(nint window);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern nint GetWindowLongPtr(nint window, int index);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint window);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] internal static extern nint WindowFromPoint(Point point);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(nint window, StringBuilder text, int length);
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] internal static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] internal static extern bool UnregisterHotKey(nint window, int id);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern nint GetThreadDesktop(uint threadId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(nint handle, int index, StringBuilder data, uint length, out uint needed);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] private static extern bool WTSQuerySessionInformation(nint server, int sessionId, int infoClass, out nint buffer, out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(nint buffer);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(nint desktop);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(nint token, int kind, nint data, int size, out int required);
    [DllImport("advapi32.dll")] private static extern nint GetSidSubAuthorityCount(nint sid);
    [DllImport("advapi32.dll")] private static extern nint GetSidSubAuthority(nint sid, uint index);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);

    internal static bool Interactive()
    {
        // WTSActive applies to both the console and connected RDP sessions. A
        // disconnected session can still expose its previous input desktop.
        int? state = null;
        if (WTSQuerySessionInformation(0, -1, 8, out var buffer, out var bytes))
        {
            try { if (buffer == 0 || bytes < sizeof(int)) return false; state = Marshal.ReadInt32(buffer); }
            finally { WTSFreeMemory(buffer); }
        }
        using var self = Process.GetCurrentProcess();
        if (!SessionConnected(state, (uint)self.SessionId, WTSGetActiveConsoleSessionId())) return false;
        var desktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
        if (desktop == 0) return false;
        try { return OnInputDesktop(DesktopName(GetThreadDesktop(GetCurrentThreadId())), DesktopName(desktop)); }
        finally { CloseDesktop(desktop); }
    }

    internal static bool ControlWindowStyle(long extendedStyle) => (extendedStyle & (0x80L | 0x08000000L)) == 0; // TOOLWINDOW / NOACTIVATE
    internal static bool ControlWindow(nint window) => ControlWindowStyle(GetWindowLongPtr(window, -20).ToInt64());

    internal static nint MainWindow(int pid)
    {
        nint main = 0; long area = 0;
        EnumWindows((window, _) =>
        {
            if (Pid(window) != pid || !IsWindowVisible(window) || GetWindow(window, WindowOwner) != 0 || !ControlWindow(window)) return true;
            var bounds = Geometry(window); var size = (long)bounds.Width * bounds.Height;
            if (size > area) { main = window; area = size; }
            return true;
        }, 0);
        return main;
    }

    // WTS queries fail when Remote Desktop Services is stopped. Only an attached
    // physical console may fall back; remote sessions still require WTSActive.
    internal static bool SessionConnected(int? state, uint sessionId, uint consoleSessionId) =>
        state == 0 || (state == null && consoleSessionId != uint.MaxValue && sessionId == consoleSessionId);

    // A locked/secure desktop must not authorize input on the helper's desktop.
    // Query names instead of activating a desktop as part of this check.
    internal static bool OnInputDesktop(string? threadDesktop, string? inputDesktop) =>
        !string.IsNullOrEmpty(threadDesktop) &&
        string.Equals(threadDesktop, inputDesktop, StringComparison.OrdinalIgnoreCase);

    private static string? DesktopName(nint desktop)
    {
        var name = new StringBuilder(256);
        return desktop != 0 && GetUserObjectInformation(desktop, 2, name, (uint)(name.Capacity * sizeof(char)), out _)
            ? name.ToString() : null;
    }

    internal static int Integrity(Process process)
    {
        if (!OpenProcessToken(process.Handle, 8, out var token)) throw new Win32Exception();
        try
        {
            GetTokenInformation(token, 25, 0, 0, out var size);
            var data = Marshal.AllocHGlobal(size);
            try
            {
                if (!GetTokenInformation(token, 25, data, size, out _)) throw new Win32Exception();
                var sid = Marshal.ReadIntPtr(data);
                var count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        finally { CloseHandle(token); }
    }

    internal static string Title(nint window) { var text = new StringBuilder(512); GetWindowText(window, text, text.Capacity); return text.ToString(); }
    internal static uint Pid(nint window) { GetWindowThreadProcessId(window, out var pid); return pid; }
    internal static Bounds Geometry(nint window) => GetWindowRect(window, out var rect) ? rect.Bounds : throw new Win32Exception();
    internal static Bounds Desktop => new(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79));
    internal static Input MouseEvent(uint flags, int x = 0, int y = 0, uint data = 0) => new() { Data = new() { Mouse = new() { X = x, Y = y, Data = data, Flags = flags } } };
    internal static Input KeyEvent(ushort key, bool up, bool unicode = false) => new()
    {
        Type = KeyboardInput,
        Data = new() { Keyboard = new()
        {
            Key = unicode ? (ushort)0 : key,
            Scan = unicode ? key : (ushort)0,
            Flags = (up ? KeyUp : 0) | (unicode ? UnicodeKey : key is >= 35 and <= 40 or 46 ? ExtendedKey : 0),
        } },
    };
}
