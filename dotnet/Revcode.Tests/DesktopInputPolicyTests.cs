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
        Assert.Contains(heartbeat > 10 ? "heartbeat" : "two minutes", policy.LeaseFailure(TimeSpan.FromSeconds(heartbeat), TimeSpan.FromSeconds(inactivity)));
        Assert.Throws<InvalidOperationException>(() => policy.RequireObservation(ready, true, "frame", "frame", Fresh));
    }

    [Fact]
    public void InputMustStayQuietForOneAndAHalfSecondsBeforeRecovery()
    {
        var settling = new InputSettling();
        settling.Sample(true, TimeSpan.Zero);
        Assert.False(settling.Ready(TimeSpan.FromMilliseconds(1499)));
        Assert.True(settling.Ready(TimeSpan.FromMilliseconds(1500)));
        settling.Sample(true, TimeSpan.FromSeconds(2)); // A held key/mouse movement resets the quiet interval.
        settling.Sample(false, TimeSpan.FromSeconds(3));
        Assert.False(settling.Ready(TimeSpan.FromSeconds(3)));
        Assert.True(settling.Ready(TimeSpan.FromMilliseconds(3500)));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void CursorChangeRefreshesBeforeInputButNeverReplaysPartialInput(int completedBatches)
    {
        var policy = new InputPolicy(); policy.Resume();
        var injections = 0;
        var receipt = InputDispatch.Run([Click, Click], () => { },
            () => InputPolicy.RequireCursor(injections < completedBatches),
            batch => { injections++; return batch.Length; }, (_, _) => { });
        Assert.Equal(completedBatches, injections);
        Assert.Equal(completedBatches == 0 ? "not-dispatched" : "unknown", receipt.Status);
        Assert.Equal(completedBatches == 0 ? "input" : null, receipt.Recovery);
        Assert.True(policy.LeaseReady(true, Fresh, Fresh));
        InputPolicy.RequireCursor(true); // A new stable screenshot authorizes input.
    }

    [Theory]
    [InlineData(false, "frame", 0)]
    [InlineData(true, "old-frame", 0)]
    [InlineData(true, "frame", 16)]
    public void PassiveMismatchedAndStaleFramesCannotAuthorizeInput(bool actionable, string requestId, int age)
    {
        var policy = new InputPolicy();
        Assert.ThrowsAny<InvalidOperationException>(() => policy.RequireObservation(true, actionable, requestId, "frame", TimeSpan.FromSeconds(age)));
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
    [Fact]
    public void ExpiredFrameRequestsObservationWithoutStoppingLeaseOrInsertingInput()
    {
        var policy = new InputPolicy(); policy.Resume();
        var injections = 0;
        var receipt = InputDispatch.Run([Click], () => { },
            () => policy.RequireObservation(policy.LeaseReady(true, Fresh, Fresh), true, "frame", "frame", TimeSpan.FromSeconds(16)),
            batch => { injections++; return batch.Length; }, (_, _) => { });
        Assert.Equal(0, injections);
        Assert.Equal("not-dispatched", receipt.Status);
        Assert.Equal("observe", receipt.Recovery);
        Assert.True(policy.LeaseReady(true, Fresh, Fresh));
        policy.RequireObservation(true, true, "new", "new", Fresh);
    }

    [Fact]
    public void RefreshAfterPartialInputRemainsUnknownAndCannotRecover()
    {
        var batches = 0;
        var receipt = InputDispatch.Run([Click, Click], () => { },
            () => { if (batches > 0) throw new ObservationRefreshException("Dialog changed"); },
            batch => { batches++; return batch.Length; }, (_, _) => { });
        Assert.Equal("unknown", receipt.Status);
        Assert.Null(receipt.Recovery);
        Assert.Equal(1, batches);
    }
    [Fact]
    public void StopRejectsQueuedStartButAllowsStartReceivedAfterStop()
    {
        var policy = new InputPolicy();
        var queuedStart = policy.CancellationGeneration;
        policy.Stop(); // Reader parses Stop before the STA executes start.
        Assert.Throws<InvalidOperationException>(() => policy.Resume(queuedStart));
        Assert.False(policy.LeaseReady(true, Fresh, Fresh));
        policy.Resume(policy.CancellationGeneration); // A later explicit start.
        Assert.True(policy.LeaseReady(true, Fresh, Fresh));
    }

    [Fact]
    public void StopAfterResumeRevokesActivationBeforeFocusRequest()
    {
        var policy = new InputPolicy();
        policy.Resume(policy.CancellationGeneration);
        policy.Stop();
        var requests = 0;
        Assert.Throws<InvalidOperationException>(() => FocusHandoff.Run(
            () => requests++, () => false,
            () => { if (!policy.LeaseReady(true, Fresh, Fresh)) throw new InvalidOperationException("Stopped"); },
            () => { }, () => { }, () => false));
        Assert.Equal(0, requests);
    }
}
