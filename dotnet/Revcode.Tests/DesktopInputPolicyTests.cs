using Revcode.Desktop;
using Xunit;

namespace Revcode.Tests;

public class DesktopInputPolicyTests
{
    private static readonly TimeSpan Fresh = TimeSpan.Zero;
    private static readonly Win32.Input[] Click = [Win32.MouseEvent(Win32.LeftDown), Win32.MouseEvent(Win32.LeftUp)];

    [Fact]
    public void LeaseRequiresOwnershipAndResumeAndStopImmediatelyRevokesIt()
    {
        var policy = new InputPolicy();
        Assert.False(policy.LeaseReady(true, Fresh, Fresh));
        policy.Resume();
        Assert.False(policy.LeaseReady(false, Fresh, Fresh));
        Assert.True(policy.LeaseReady(true, Fresh, Fresh));
        policy.Stop();
        Assert.False(policy.LeaseReady(true, Fresh, Fresh));
    }

    [Theory]
    [InlineData(11, 0)]
    [InlineData(0, 121)]
    public void WatchdogAndDispatchUseTheSameLeaseExpiry(int heartbeat, int inactivity)
    {
        var policy = new InputPolicy();
        policy.Resume();
        var ready = policy.LeaseReady(true, TimeSpan.FromSeconds(heartbeat), TimeSpan.FromSeconds(inactivity));
        Assert.False(ready);
        Assert.Throws<InvalidOperationException>(() => policy.RequireObservation(ready, true, "frame", "frame", Fresh));
    }

    [Theory]
    [InlineData(false, "frame", 0)]
    [InlineData(true, "old-frame", 0)]
    [InlineData(true, "frame", 16)]
    public void PassiveMismatchedAndStaleFramesCannotAuthorizeInput(bool actionable, string requestId, int age)
    {
        var policy = new InputPolicy();
        Assert.Throws<InvalidOperationException>(() => policy.RequireObservation(true, actionable, requestId, "frame", TimeSpan.FromSeconds(age)));
    }

    [Fact]
    public void OverlayAppearingDuringMessagePumpIsRejectedBeforeInjection()
    {
        var overlay = false;
        var injections = 0;
        var receipt = InputDispatch.Run([Click], () => overlay = true,
            () => { if (overlay) throw new InvalidOperationException("Target occluded."); },
            batch => { injections++; return batch.Length; }, (_, _) => { });
        Assert.Equal(0, injections);
        Assert.Equal("not-dispatched", receipt.Status);
    }

    [Fact]
    public void StopBetweenBatchesPreventsFurtherInputAndReportsPartialOutcome()
    {
        var policy = new InputPolicy();
        policy.Resume();
        var injections = 0;
        var receipt = InputDispatch.Run([Click, Click],
            () => { if (injections == 1) policy.Stop(); },
            () => policy.RequireObservation(policy.LeaseReady(true, Fresh, Fresh), true, "frame", "frame", Fresh),
            batch => { injections++; return batch.Length; }, (_, _) => { });
        Assert.Equal(1, injections);
        Assert.Equal(new Receipt("unknown", 2, "Fresh actionable observation and active lease required."), receipt);
    }

    [Fact]
    public void PartialInsertionIsTrackedOnceAndNeverResent()
    {
        var injections = 0;
        var tracked = 0;
        var receipt = InputDispatch.Run([Click, Click], () => { }, () => { },
            _ => { injections++; return 1; }, (_, count) => tracked += count);
        Assert.Equal(1, injections);
        Assert.Equal(1, tracked);
        Assert.Equal("unknown", receipt.Status);
        Assert.Equal(1, receipt.Inserted);
    }

    [Fact]
    public void UnknownFenceSurvivesStopAndRefusesRestart()
    {
        var policy = new InputPolicy();
        policy.Resume();
        policy.MarkUnknown();
        policy.Stop();
        Assert.True(policy.Unknown);
        Assert.False(policy.LeaseReady(true, Fresh, Fresh));
        Assert.Throws<InvalidOperationException>(policy.Resume);
    }
}
