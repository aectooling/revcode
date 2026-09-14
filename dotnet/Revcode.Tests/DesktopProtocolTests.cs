using Revcode.Desktop;
using Xunit;

namespace Revcode.Tests;

public class DesktopProtocolTests
{
    [Theory]
    [InlineData("HwndWrapper[DefaultDomain;;popup]", 0x80000000L, 0x08000088L, true, 100u, 100u, 20u, 20u, true)]
    [InlineData("HwndWrapper[DefaultDomain;;popup]", 0x80000000L, 0x08000088L, true, 100u, 200u, 20u, 20u, false)]
    [InlineData("HwndWrapper[DefaultDomain;;popup]", 0x80000000L, 0x08000088L, true, 100u, 100u, 20u, 30u, false)]
    [InlineData("HwndWrapper[DefaultDomain;;popup]", 0x80000000L, 0x080000a8L, true, 100u, 100u, 20u, 20u, false)]
    [InlineData("HwndWrapper[DefaultDomain;;popup]", 0x80000000L, 0x08000088L, false, 100u, 100u, 20u, 20u, false)]
    [InlineData("HwndWrapper[DefaultDomain;;main]", 0L, 0x08000088L, true, 100u, 100u, 20u, 20u, false)]
    [InlineData("HwndWrapper[DefaultDomain;;popup]", 0x80000000L, 0x80L, true, 100u, 100u, 20u, 20u, false)]
    [InlineData("tooltips_class32", 0x80000000L, 0x08000088L, true, 100u, 100u, 20u, 20u, false)]
    [InlineData("HwndWrapper[DefaultDomain;;popup]", 0x80000000L, 0x08000088L, true, 0u, 0u, 0u, 0u, false)]
    public void WpfPopupRequiresInteractivePopupStyleAndMatchingProcessAndThread(string className, long style, long extendedStyle,
        bool enabled, uint pid, uint ownerPid, uint thread, uint ownerThread, bool expected) =>
        Assert.Equal(expected, Win32.OwnedWpfPopup(className, style, extendedStyle, enabled, pid, ownerPid, thread, ownerThread));

    [Theory]
    [InlineData(1, 1, 0, false, true)]
    [InlineData(2, 1, 1, true, true)]
    [InlineData(2, 1, 1, false, false)] // Menu appeared after observation.
    [InlineData(2, 1, 3, true, false)] // Another window's menu.
    [InlineData(2, 1, 0, true, false)] // Unrelated overlay or tooltip.
    [InlineData(0, 0, 0, true, false)]
    public void PointerRequiresObservedWindowOrItsObservedActiveMenu(int hit, int window, int owner, bool observed, bool expected) =>
        Assert.Equal(expected, Win32.PointerTargetAllowed(hit, window, owner, observed));

    [Fact]
    public void GuiThreadInfoMatchesWindowsX64Abi() =>
        Assert.Equal(72, System.Runtime.InteropServices.Marshal.SizeOf<Win32.GuiThreadInfo>());

    [Theory]
    [InlineData(4u, 100u, 100u, true)]
    [InlineData(16u, 100u, 100u, true)]
    [InlineData(0u, 100u, 100u, false)]
    [InlineData(4u, 100u, 200u, false)]
    [InlineData(4u, 0u, 0u, false)]
    public void PopupMenuRequiresActiveMenuModeAndSameProcess(uint flags, uint menuPid, uint ownerPid, bool expected) =>
        Assert.Equal(expected, Win32.MenuOwnerMatches(flags, menuPid, ownerPid));

    [Theory]
    [InlineData(0, 2u, 1u, true)] // Active RDP.
    [InlineData(0, 1u, 1u, true)] // Active console.
    [InlineData(4, 2u, 1u, false)] // Disconnected RDP.
    [InlineData(4, 1u, 1u, false)] // A known non-active state never falls back.
    [InlineData(null, 1u, 1u, true)] // Console without Remote Desktop Services.
    [InlineData(null, 2u, 1u, false)] // Unknown remote state fails closed.
    [InlineData(null, 1u, uint.MaxValue, false)] // No attached console.
    public void ConnectionAllowsActiveRdpAndConsoleFallback(int? state, uint sessionId, uint consoleSessionId, bool expected)
    {
        Assert.Equal(expected, Win32.SessionConnected(state, sessionId, consoleSessionId));
    }

    [Theory]
    [InlineData("Default", "Default", true)]
    [InlineData("Default", "Winlogon", false)] // Locked/secure desktop.
    [InlineData("Default", null, false)] // Access denied/query failed.
    [InlineData(null, "Default", false)]
    [InlineData("", "", false)]
    public void DesktopAccessRequiresMatchingAccessibleInputDesktop(string? threadDesktop, string? inputDesktop, bool expected)
    {
        Assert.Equal(expected, Win32.OnInputDesktop(threadDesktop, inputDesktop));
    }

    [Fact]
    public void InputLayoutMatchesWindowsX64Abi()
    {
        Assert.Equal(40, System.Runtime.InteropServices.Marshal.SizeOf<Win32.Input>());
        Assert.Equal(8, System.Runtime.InteropServices.Marshal.OffsetOf<Win32.Input>(nameof(Win32.Input.Data)).ToInt32());
        Assert.Equal(32, System.Runtime.InteropServices.Marshal.SizeOf<Win32.Mouse>());
        Assert.Equal(24, System.Runtime.InteropServices.Marshal.SizeOf<Win32.Keyboard>());
    }

    [Fact]
    public void UnicodeAndExtendedControlEventsIncludeCorrectFlags()
    {
        var unicode = Win32.KeyEvent('\uD83D', true, true);
        Assert.Equal(1u, unicode.Type);
        Assert.Equal(0, unicode.Data.Keyboard.Key);
        Assert.Equal(0xD83D, unicode.Data.Keyboard.Scan);
        Assert.Equal(6u, unicode.Data.Keyboard.Flags);
        Assert.Equal(3u, Win32.KeyEvent(46, true).Data.Keyboard.Flags);
        Assert.Equal(2u, Win32.KeyEvent(65, true).Data.Keyboard.Flags);
    }

    [Fact]
    public void MapsResizedCropOnNegativeOriginMonitor()
    {
        Assert.Equal((-1720, 400), Coordinates.Map(new(-1820, 200, 800, 600), 400, 300, 50, 100));
        Assert.Equal((-1022, 798), Coordinates.Map(new(-1820, 200, 800, 600), 400, 300, 399, 299));
    }

    [Fact]
    public void VirtualDesktopEdgesReachFullNormalizedRange()
    {
        var desktop = new Bounds(-1920, -1080, 5760, 3240);
        Assert.Equal((0, 0), Coordinates.Normalize(desktop, -1920, -1080));
        Assert.Equal((65535, 65535), Coordinates.Normalize(desktop, 3839, 2159));
        Assert.Throws<ArgumentException>(() => Coordinates.Normalize(desktop, 3840, 0));
    }

    [Theory]
    [InlineData(-1, 0)]
    [InlineData(400, 0)]
    [InlineData(0, 300)]
    [InlineData(double.NaN, 0)]
    [InlineData(double.PositiveInfinity, 0)]
    public void RejectsInvalidImageCoordinates(double x, double y) => Assert.Throws<ArgumentException>(() => Coordinates.Map(new(0, 0, 800, 600), 400, 300, x, y));

    [Fact]
    public void DuplicateDispatchReturnsReceiptAndRejectsChangedContent()
    {
        var ledger = new DispatchLedger();
        var request = new Request(1, "action-1", "action", "generation", "image-1", "click", 10, 20);
        Assert.Null(ledger.Find(request)); ledger.Begin(request);
        Assert.Equal("unknown", ledger.Find(request)!.Status);
        var receipt = new Receipt("dispatched", 3); ledger.Complete(request, receipt);
        Assert.Same(receipt, ledger.Find(request));
        Assert.Throws<InvalidOperationException>(() => ledger.Find(request with { X = 50 }));
        Assert.Throws<InvalidOperationException>(() => ledger.Find(request with { Generation = "new-generation" }));
    }

    [Fact]
    public void FullLedgerDoesNotEvictAnOldDispatch()
    {
        var ledger = new DispatchLedger(1); var request = new Request(1, "first", "action");
        ledger.Begin(request);
        Assert.Throws<InvalidOperationException>(() => ledger.Begin(request with { RequestId = "second" }));
        Assert.Equal("unknown", ledger.Find(request)!.Status);
    }
}
