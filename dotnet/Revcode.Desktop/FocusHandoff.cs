namespace Revcode.Desktop;

internal static class FocusHandoff
{
    internal static void SendHotkey(Action pump, Action validate, Func<Win32.Input[], int> insert,
        Action<Win32.Input[], int> track, InputPolicy policy)
    {
        var batch = new[] { Win32.KeyEvent(Win32.FocusKey, false), Win32.KeyEvent(Win32.FocusKey, true) };
        var receipt = InputDispatch.Run([batch], pump, validate, insert, track);
        if (receipt.Status == "dispatched") return;
        if (receipt.Status == "unknown") policy.MarkUnknown(); else policy.Stop();
        throw new InvalidOperationException("Desktop activation input failed. " + receipt.Error);
    }

    // Cross-process activation is asynchronous. Request once, then keep Stop
    // responsive while waiting for the target to actually become foreground.
    internal static void Run(Action request, Func<bool> ready, Action validate,
        Action pump, Action pause, Func<bool> timedOut)
    {
        validate();
        if (ready()) return;
        request();
        while (true)
        {
            pump();
            validate();
            if (ready()) return;
            if (timedOut()) throw new InvalidOperationException("Windows did not finish activating Revit. Close any blocking menu or dialog and retry the task.");
            pause();
        }
    }
}
