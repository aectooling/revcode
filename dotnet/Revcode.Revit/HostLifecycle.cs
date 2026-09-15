namespace Revcode.Revit;

// Keeps host generations serialized without blocking Revit's UI thread.
internal sealed class HostLifecycle : IDisposable
{
    private readonly object gate = new();
    private CancellationTokenSource? cancellation;
    private Task? worker;
    private bool stopping;
    private bool restart;
    private bool disposed;
    private bool running;
    private string? error;
    private string? notice;

    public string Status
    {
        get
        {
            lock (gate)
                return stopping ? (restart ? "Restarting" : "Stopping")
                    : error != null ? "Failed: " + error
                    : worker is { IsCompleted: false } ? (running ? "Running" : "Starting") : "Stopped";
        }
    }

    public void Open(Func<CancellationToken, Task> start, Action openBrowser)
    {
        lock (gate)
        {
            if (disposed) return;
            if (stopping) { restart = true; return; }
            if (worker is { IsCompleted: false }) { if (running) openBrowser(); return; }
            cancellation?.Dispose();
            cancellation = new();
            var token = cancellation.Token;
            error = notice = null;
            running = false;
            worker = Task.Run(async () =>
            {
                try { await start(token); }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { }
                catch (Exception ex)
                {
                    lock (gate) { if (!token.IsCancellationRequested) error = notice = ex.Message; }
                }
                finally { lock (gate) running = false; }
            });
        }
    }

    public void Ready(CancellationToken token, Action openBrowser)
    {
        lock (gate)
        {
            token.ThrowIfCancellationRequested();
            running = true;
            openBrowser();
        }
    }

    public void Stop(bool restartAfterStop = false)
    {
        lock (gate)
        {
            if (disposed) return;
            stopping = true;
            restart = restartAfterStop;
            error = notice = null;
            cancellation?.Cancel();
        }
    }

    // Called on Revit's UI thread; don't restart until cancelled native work also settles.
    public bool Poll(bool nativeIdle, out string? message)
    {
        lock (gate)
        {
            message = notice;
            notice = null;
            if (disposed || !stopping || worker is { IsCompleted: false } || !nativeIdle) return false;
            stopping = false;
            var shouldRestart = restart;
            restart = false;
            return shouldRestart;
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            cancellation?.Cancel();
        }
    }
}
