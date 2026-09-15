using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Revcode.Desktop;

// Count events, not held-key samples: even a complete tap invalidates old evidence.
// Only this helper's tagged SendInput events are excluded, not other automation.
internal sealed class InputRevision
{
    private long value;
    public long Value => Interlocked.Read(ref value);
    public void Record(bool injected, nuint extra)
    {
        if (!injected || extra != Win32.InputTag) Interlocked.Increment(ref value);
    }
    public void RequireUnchanged(long captured)
    {
        if (captured != Value) throw new InputRecoveryException("User input occurred after capture. Observe again before sending input.");
    }
}

// Low-level hooks need a responsive message loop. Keep screenshots and Revit
// validation off this thread; callbacks only increment an atomic revision.
internal sealed class InputMonitor : IDisposable
{
    private delegate nint HookProc(int code, nuint message, nint data);
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardEvent { public uint Key, Scan, Flags, Time; public nuint Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseEvent { public Win32.Point Point; public uint Data, Flags, Time; public nuint Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public nint Window; public uint Id; public nuint WParam; public nint LParam; public uint Time; public Win32.Point Point; public uint Private; }
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetWindowsHookExW(int kind, HookProc callback, nint module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] private static extern nint CallNextHookEx(nint hook, int code, nuint message, nint data);
    [DllImport("user32.dll")] private static extern int GetMessageW(out Message message, nint window, uint first, uint last);
    [DllImport("user32.dll")] private static extern bool PeekMessageW(out Message message, nint window, uint first, uint last, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostThreadMessageW(uint thread, uint message, nuint wParam, nint lParam);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandleW(string? name);

    public InputRevision Revision { get; } = new();
    private readonly Thread thread;
    private readonly HookProc keyboardCallback, mouseCallback;
    private readonly TaskCompletionSource<uint> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int disposed;

    public InputMonitor()
    {
        keyboardCallback = (code, message, data) =>
        {
            if (code >= 0) { var input = Marshal.PtrToStructure<KeyboardEvent>(data); Revision.Record((input.Flags & 0x10) != 0, input.Extra); }
            return CallNextHookEx(0, code, message, data);
        };
        mouseCallback = (code, message, data) =>
        {
            if (code >= 0) { var input = Marshal.PtrToStructure<MouseEvent>(data); Revision.Record((input.Flags & 1) != 0, input.Extra); }
            return CallNextHookEx(0, code, message, data);
        };
        thread = new Thread(Run) { IsBackground = true, Name = "Desktop input monitor" };
        thread.Start();
        ready.Task.GetAwaiter().GetResult();
    }

    private void Run()
    {
        nint keyboard = 0, mouse = 0;
        try
        {
            PeekMessageW(out _, 0, 0, 0, 0); // Create the queue before publishing its ID.
            var module = GetModuleHandleW(null);
            keyboard = SetWindowsHookExW(13, keyboardCallback, module, 0);
            if (keyboard == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not monitor keyboard input.");
            mouse = SetWindowsHookExW(14, mouseCallback, module, 0);
            if (mouse == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not monitor mouse input.");
            ready.SetResult(GetCurrentThreadId());
            while (GetMessageW(out _, 0, 0, 0) > 0) { }
        }
        catch (Exception error) { ready.TrySetException(error); }
        finally
        {
            if (mouse != 0) UnhookWindowsHookEx(mouse);
            if (keyboard != 0) UnhookWindowsHookEx(keyboard);
        }
    }

    public void RequireRunning()
    {
        if (!thread.IsAlive || Volatile.Read(ref disposed) != 0) throw new InvalidOperationException("Desktop input monitor stopped.");
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        PostThreadMessageW(ready.Task.GetAwaiter().GetResult(), 0x12, 0, 0); // WM_QUIT
        thread.Join();
    }
}
