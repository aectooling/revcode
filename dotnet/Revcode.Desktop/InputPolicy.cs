namespace Revcode.Desktop;

// Pure control policy shared by the watchdog and dispatch path. Native ownership
// remains with the session's thread-affine mutex.
internal sealed class InputPolicy
{
    private volatile bool stopped = true;
    public bool Unknown { get; private set; }

    public void Resume()
    {
        if (Unknown) throw new InvalidOperationException("Input outcome unknown; inspect and end this helper generation.");
        stopped = false;
    }

    public void Stop() => stopped = true;
    public void MarkUnknown() { Unknown = true; Stop(); }

    public bool LeaseReady(bool owned, TimeSpan heartbeatAge, TimeSpan inactivityAge) =>
        owned && !stopped && !Unknown && heartbeatAge <= TimeSpan.FromSeconds(10) && inactivityAge <= TimeSpan.FromMinutes(2);

    public void RequireObservation(bool leaseReady, bool actionable, string? requestedId, string actualId, TimeSpan age)
    {
        if (!leaseReady || !actionable || requestedId != actualId || age > TimeSpan.FromSeconds(15))
            throw new InvalidOperationException("Fresh actionable observation and active lease required.");
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
            return new Receipt(inserted > 0 ? "unknown" : "not-dispatched", inserted, error.Message);
        }
    }
}
