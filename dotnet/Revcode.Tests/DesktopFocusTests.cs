using Revcode.Desktop;
using Xunit;

namespace Revcode.Tests;

public class DesktopFocusTests
{
    [Theory]
    [InlineData(0, false)]
    [InlineData(1, true)]
    public void FailedHotkeyInsertionTracksReleasesAndOnlyPartialInputFences(int inserted, bool unknown)
    {
        var policy = new InputPolicy(); policy.Resume();
        var held = new HashSet<ushort>();
        Assert.Throws<InvalidOperationException>(() => FocusHandoff.SendHotkey(() => {}, () => {}, batch =>
        {
            Assert.Equal(2, batch.Length);
            Assert.All(batch, input => Assert.Equal(Win32.FocusKey, input.Data.Keyboard.Key));
            return inserted;
        }, (batch, count) =>
        {
            foreach (var input in batch.Take(count))
                if ((input.Data.Keyboard.Flags & Win32.KeyUp) == 0) held.Add(input.Data.Keyboard.Key);
                else held.Remove(input.Data.Keyboard.Key);
        }, policy));
        Assert.Equal(unknown, policy.Unknown);
        Assert.Equal(inserted, held.Count); // Stop can release exactly the inserted down.
        Assert.False(policy.LeaseReady(true, TimeSpan.Zero, TimeSpan.Zero));
    }

    [Fact]
    public void StopBeforeHotkeyDispatchInsertsNothing()
    {
        var policy = new InputPolicy(); policy.Resume();
        Assert.Throws<InvalidOperationException>(() => FocusHandoff.SendHotkey(policy.Stop,
            () => { if (!policy.LeaseReady(true, TimeSpan.Zero, TimeSpan.Zero)) throw new OperationCanceledException(); },
            _ => throw new Exception("Unexpected input"), (_, _) => {}, policy));
        Assert.False(policy.Unknown);
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(0x40000, true)] // Ordinary application window.
    [InlineData(0x1, true)] // Modal dialog frame.
    [InlineData(0x80, false)] // Tool window, including transient tooltips.
    [InlineData(0x08000000, false)] // Non-activating popup.
    [InlineData(0x08000088, false)]
    public void AuxiliaryWindowsCannotReplaceMainWindowOrAuthorizeInput(long style, bool expected) =>
        Assert.Equal(expected, Win32.ControlWindowStyle(style));

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
