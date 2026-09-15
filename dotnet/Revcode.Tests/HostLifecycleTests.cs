using Revcode.Revit;
using Xunit;

namespace Revcode.Tests;

public class HostLifecycleTests
{
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static async Task Until(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!condition()) await Task.Delay(10, timeout.Token);
    }

    [Fact]
    public async Task RepeatedOpenStartsOneHostAndReopensOnlyWhenReady()
    {
        using var host = new HostLifecycle();
        var ready = Signal();
        var starts = 0;
        var opens = 0;
        async Task Start(CancellationToken token)
        {
            Interlocked.Increment(ref starts);
            await ready.Task.WaitAsync(token);
            host.Ready(token, () => Interlocked.Increment(ref opens));
            await Task.Delay(Timeout.Infinite, token);
        }
        host.Open(Start, () => opens++);
        host.Open(Start, () => opens++);
        Assert.Equal("Starting", host.Status);
        Assert.Equal(0, opens);
        ready.SetResult();
        await Until(() => host.Status == "Running");
        host.Open(Start, () => opens++);
        Assert.Equal(1, starts);
        Assert.Equal(2, opens);
        host.Stop();
        await Until(() => { host.Poll(true, out _); return host.Status == "Stopped"; });
    }

    [Fact]
    public async Task RestartWaitsForProcessCleanupAndNativeWork()
    {
        using var host = new HostLifecycle();
        var entered = Signal();
        var cleanup = Signal();
        host.Open(async token =>
        {
            entered.SetResult();
            try { await Task.Delay(Timeout.Infinite, token); }
            finally { await cleanup.Task; }
        }, () => { });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        host.Stop(true);
        host.Stop(true);
        Assert.Equal("Restarting", host.Status);
        Assert.False(host.Poll(true, out _));
        cleanup.SetResult();
        Assert.False(host.Poll(false, out _));
        await Until(() => host.Poll(true, out _));
        Assert.False(host.Poll(true, out _));
        Assert.Equal("Stopped", host.Status);
    }

    [Fact]
    public async Task StopDuringStartupPreventsBrowserAndOpenQueuesRestart()
    {
        using var host = new HostLifecycle();
        var entered = Signal();
        var ready = Signal();
        var opened = false;
        host.Open(async token =>
        {
            entered.SetResult();
            await ready.Task;
            host.Ready(token, () => opened = true);
        }, () => opened = true);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        host.Stop();
        host.Open(_ => throw new Exception("Must not start before cleanup"), () => opened = true);
        Assert.Equal("Restarting", host.Status);
        ready.SetResult();
        await Until(() => host.Poll(true, out _));
        Assert.False(opened);
    }

    [Fact]
    public void StopOverridesPendingRestartAndDoesNotStartAnUnusedHost()
    {
        using var host = new HostLifecycle();
        host.Stop(true);
        host.Stop();
        Assert.False(host.Poll(true, out _));
        Assert.Equal("Stopped", host.Status);
    }

    [Fact]
    public async Task FailureRemainsVisibleAfterOneTimeNoticeAndCanRetry()
    {
        using var host = new HostLifecycle();
        host.Open(_ => throw new InvalidOperationException("Host exited"), () => { });
        await Until(() => host.Status.StartsWith("Failed:"));
        Assert.False(host.Poll(true, out var notice));
        Assert.Equal("Host exited", notice);
        host.Poll(true, out notice);
        Assert.Null(notice);
        Assert.Equal("Failed: Host exited", host.Status);
        await Until(() =>
        {
            host.Open(async token => { host.Ready(token, () => { }); await Task.Delay(Timeout.Infinite, token); }, () => { });
            return host.Status == "Running";
        });
        host.Stop();
        await Until(() => { host.Poll(true, out _); return host.Status == "Stopped"; });
    }
}
