using Revcode.Desktop;
using Xunit;

public class DesktopInputMonitorTests
{
    [Fact]
    public void CompletedTapInvalidatesScreenshotEvenAfterQuietPeriod()
    {
        var revision = new InputRevision();
        var captured = revision.Value;
        revision.Record(false, 0); // down
        revision.Record(false, 0); // up, before a watchdog sample
        var settling = new InputSettling();
        Assert.True(settling.Ready(TimeSpan.FromSeconds(2)));
        Assert.Throws<InputRecoveryException>(() => revision.RequireUnchanged(captured));
        revision.RequireUnchanged(revision.Value); // A new screenshot can authorize input.
    }

    [Fact]
    public void OnlyOwnTaggedInjectionIsExcluded()
    {
        var revision = new InputRevision();
        revision.Record(true, Win32.KeyEvent(9, false).Data.Keyboard.Extra);
        revision.Record(true, Win32.KeyEvent(9, true).Data.Keyboard.Extra);
        revision.Record(true, Win32.MouseEvent(Win32.LeftDown).Data.Mouse.Extra);
        revision.RequireUnchanged(0);
        revision.Record(true, Win32.InputTag ^ 1); // Another input injector.
        Assert.Equal(1, revision.Value);
        revision.Record(false, Win32.InputTag); // A tag alone cannot hide physical input.
        Assert.Equal(2, revision.Value);
    }

    [Fact]
    public void TapBetweenTypingBatchesStopsRemainingInputWithoutReplay()
    {
        var revision = new InputRevision();
        var captured = revision.Value;
        var sends = 0;
        var receipt = InputDispatch.Run(new[] { new Win32.Input[2], new Win32.Input[2] },
            () => { if (sends == 1) { revision.Record(false, 0); revision.Record(false, 0); } },
            () => revision.RequireUnchanged(captured),
            batch => { sends++; return batch.Length; }, (_, _) => { });
        Assert.Equal("unknown", receipt.Status);
        Assert.Equal(2, receipt.Inserted);
        Assert.Equal(1, sends);
    }

    [Fact]
    public void HooksCanBeInstalledAndReleasedAcrossTurns()
    {
        if (!OperatingSystem.IsWindows()) return;
        for (var turn = 0; turn < 2; turn++)
        {
            var monitor = new InputMonitor();
            monitor.RequireRunning();
            monitor.Dispose();
            Assert.Throws<InvalidOperationException>(monitor.RequireRunning);
            monitor.Dispose();
        }
    }
}
