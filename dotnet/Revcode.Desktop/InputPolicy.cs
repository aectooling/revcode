namespace Revcode.Desktop;

// Pure control policy shared by the watchdog and dispatch path. Native ownership
// remains with the session's thread-affine mutex.
internal sealed class ObservationRefreshException(string message) : InvalidOperationException(message);

internal sealed class InputPolicy
{
    private volatile bool stopped = true;
    private readonly object cancellationLock = new();
    private int cancellationGeneration;
    public int CancellationGeneration { get { lock (cancellationLock) return cancellationGeneration; } }
    public bool Unknown { get; private set; }

    public void Resume() => Resume(CancellationGeneration);

    public void Resume(int expectedGeneration)
    {
        lock (cancellationLock)
        {
            if (expectedGeneration != cancellationGeneration) throw new InvalidOperationException("Desktop start was cancelled before execution.");
            if (Unknown) throw new InvalidOperationException("Input outcome unknown; inspect and end this helper generation.");
            stopped = false;
        }
    }

    public void Stop()
    {
        lock (cancellationLock) { ++cancellationGeneration; stopped = true; }
    }
    public void MarkUnknown() { Unknown = true; Stop(); }

    public bool LeaseReady(bool owned, TimeSpan heartbeatAge, TimeSpan inactivityAge) =>
        owned && LeaseFailure(heartbeatAge, inactivityAge) == null;

    public string? LeaseFailure(TimeSpan heartbeatAge, TimeSpan inactivityAge) =>
        Unknown ? "Desktop input outcome is unknown. Inspect Revit before continuing." :
        stopped ? "Desktop control stopped." :
        heartbeatAge > TimeSpan.FromSeconds(10) ? "Desktop control paused: the host heartbeat was missing for more than 10 seconds." :
        inactivityAge > TimeSpan.FromMinutes(2) ? "Desktop control paused: no input action was dispatched for two minutes." : null;

    public static string? InterferenceReason(bool boundForeground, bool cursorUnchanged, bool heldInput) =>
        !boundForeground ? "Desktop control paused: focus moved outside Revit. Activate Revit and start a new turn." :
        heldInput ? "Desktop control paused: a key or mouse button is held. Release it and start a new turn." :
        !cursorUnchanged ? "Desktop control paused: the mouse moved after the screenshot. Start a new turn and leave the mouse still during control." : null;

    public void RequireObservation(bool leaseReady, bool actionable, string? requestedId, string actualId, TimeSpan age)
    {
        if (!leaseReady || !actionable || requestedId != actualId)
            throw new InvalidOperationException("Fresh actionable observation and active lease required.");
        if (age > TimeSpan.FromSeconds(15))
            throw new ObservationRefreshException("The screenshot is older than 15 seconds. No input was sent; observe again.");
    }
}

internal static class InputDispatch
{
    // The validation callback includes pointer hit-testing. Nothing that pumps
    // messages or awaits work may be inserted between validation and injection.
    public static Receipt Run(IEnumerable<Win32.Input[]> batches, Action pump, Action validate,
        Func<Win32.Input[], int> insert, Action<Win32.Input[], int> track)
    {
        var inserted = 0;
        try
        {
            foreach (var batch in batches)
            {
                pump();
                validate();
                var count = insert(batch);
                inserted += count;
                track(batch, count);
                if (count != batch.Length)
                    throw new InvalidOperationException("SendInput inserted only part of the batch; do not retry.");
            }
            return new Receipt("dispatched", inserted);
        }
        catch (Exception error)
        {
            return new Receipt(inserted > 0 ? "unknown" : "not-dispatched", inserted, error.Message,
                Recovery: inserted == 0 && error is ObservationRefreshException ? "observe" : null);
        }
    }
}
