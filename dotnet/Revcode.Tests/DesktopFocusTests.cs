using Revcode.Desktop;
using Xunit;

namespace Revcode.Tests;

public class DesktopFocusTests
{
    [Fact]
    public void WaitsForAsynchronousActivationWithoutRepeatingRequest()
    {
        var requests = 0; var ticks = 0;
        FocusHandoff.Run(() => requests++, () => ticks == 3, () => {}, () => {}, () => ticks++, () => ticks >= 4);
        Assert.Equal(1, requests);
        Assert.Equal(3, ticks);
    }

    [Fact]
    public void AlreadyForegroundDoesNotRequestActivation()
    {
        FocusHandoff.Run(() => throw new Exception("Unexpected activation"), () => true, () => {},
            () => throw new Exception("Unexpected pump"), () => {}, () => false);
    }

    [Fact]
    public void StopProcessedDuringHandoffCannotReturnSuccess()
    {
        var stopped = false; var ready = false;
        Assert.Throws<OperationCanceledException>(() => FocusHandoff.Run(() => {}, () => ready,
            () => { if (stopped) throw new OperationCanceledException(); },
            () => { stopped = true; ready = true; }, () => {}, () => false));
    }

    [Fact]
    public void RefusedActivationTimesOutWithoutRetryingOrDispatchingInput()
    {
        var requests = 0; var ticks = 0;
        Assert.Throws<InvalidOperationException>(() => FocusHandoff.Run(() => requests++, () => false,
            () => {}, () => {}, () => ticks++, () => ticks >= 3));
        Assert.Equal(1, requests);
        Assert.Equal(3, ticks);
    }
}
