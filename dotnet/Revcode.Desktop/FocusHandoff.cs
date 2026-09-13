namespace Revcode.Desktop;

internal static class FocusHandoff
{
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
