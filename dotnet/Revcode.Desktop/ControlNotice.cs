using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Revcode.Desktop;

// Full-screen visual curtain. Keep Revit focused and let agent input pass through.
// This is not an OS lock; the registered emergency-stop shortcut remains available.
internal sealed class ControlNotice : Form
{
    private bool waiting;
    private Bitmap? frost;
    private long lastBackdrop;
    private Point? agentPointer;
    private readonly Queue<string> activity = new();
    public ControlNotice()
    {
        Text = "Revcode computer use";
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
        StartPosition = FormStartPosition.Manual; BackColor = Color.FromArgb(245, 246, 248);
        Opacity = 0.99; DoubleBuffered = true;
    }
    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get { var value = base.CreateParams; value.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020; return value; }
    }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowDisplayAffinity(nint window, uint affinity);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Keep the curtain out of the screenshots used by the agent.
        // https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity
        if (!SetWindowDisplayAffinity(Handle, 0x11))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not exclude the computer-use overlay from screenshots.");
    }
    public void Display(nint target, bool waiting)
    {
        Bounds = Screen.FromHandle(target).Bounds;
        if (this.waiting != waiting) { this.waiting = waiting; Invalidate(); }
        if (!Visible) { activity.Clear(); agentPointer = null; }
        if (!Visible || Environment.TickCount64 - lastBackdrop >= 1000) RefreshFrost();
        if (!Visible) Show();
    }
    private void RefreshFrost()
    {
        lastBackdrop = Environment.TickCount64;
        // Downsample the capture-excluded desktop, then softly upscale it beneath
        // an opaque white tint. Refresh at 1 Hz rather than on every input tick.
        try
        {
            using var capture = new Bitmap(Width, Height);
            using (var graphics = Graphics.FromImage(capture))
                graphics.CopyFromScreen(Left, Top, 0, 0, capture.Size);
            var next = new Bitmap(Math.Max(1, Width / 32), Math.Max(1, Height / 32));
            using (var graphics = Graphics.FromImage(next))
            {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                graphics.DrawImage(capture, new Rectangle(Point.Empty, next.Size));
            }
            frost?.Dispose(); frost = next; Invalidate();
        }
        catch (Win32Exception) { /* Keep the last backdrop if the desktop is temporarily unavailable. */ }
        catch (ExternalException) { }
    }
    public void RecordObservation() => Record("Screenshot captured");
    public void RecordAction(Request request, Receipt receipt, Observation frame)
    {
        if (receipt.Inserted > 0 && request.Action is "move" or "click" or "scroll")
        {
            var (x, y) = Coordinates.Map(frame.Crop, frame.Width, frame.Height, request.X!.Value, request.Y!.Value);
            agentPointer = new Point(x, y);
        }
        var label = request.Action switch
        {
            "type" => $"Type {request.Text?.Length ?? 0} characters",
            "key" => $"Press {string.Join(" + ", request.Keys ?? [])}",
            "scroll" => $"Scroll {request.Direction}",
            "click" => "Click",
            _ => "Move pointer"
        };
        Record($"{label} · {(receipt.Status == "dispatched" ? "Input sent" : receipt.Status == "unknown" ? "Unconfirmed" : "Not sent")}");
    }
    private void Record(string text)
    {
        activity.Enqueue($"{DateTime.Now:HH:mm:ss}   {text}");
        while (activity.Count > 4) activity.Dequeue();
        Invalidate();
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) frost?.Dispose();
        base.Dispose(disposing);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        if (frost != null) e.Graphics.DrawImage(frost, ClientRectangle);
        using (var tint = new SolidBrush(Color.FromArgb(190, 250, 252, 255))) e.Graphics.FillRectangle(tint, ClientRectangle);
        var center = ClientSize.Height / 2 - 65;
        using var title = new Font("Segoe UI", 26, FontStyle.Bold);
        using var body = new Font("Segoe UI", 12);
        using var small = new Font("Segoe UI", 10);
        using var ink = new SolidBrush(Color.FromArgb(24, 26, 32));
        using var muted = new SolidBrush(Color.FromArgb(100, 105, 116));
        using var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        using var pen = new Pen(Color.FromArgb(100, 105, 116), 3);
        var x = ClientSize.Width / 2;
        e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        e.Graphics.DrawArc(pen, x - 10, center - 151, 20, 26, 180, 180);
        e.Graphics.DrawRectangle(pen, x - 17, center - 138, 34, 26);
        void Line(string text, Font font, Brush brush, int y, int height) =>
            e.Graphics.DrawString(text, font, brush, new RectangleF(24, y, ClientSize.Width - 48, height), format);
        Line("REVCODE · COMPUTER USE", small, muted, center - 85, 30);
        Line("Revcode is working in Revit", title, ink, center - 40, 60);
        Line("Your session will be ready when the agent finishes.", body, muted, center + 28, 40);
        Line(waiting ? "Waiting to resume…" : "Computer use in progress", body, muted, center + 95, 35);
        Line("Ctrl + Alt + F12  ·  Stop and take control", body, ink, center + 155, 40);
        var row = center + 220;
        foreach (var entry in activity.Reverse()) { Line(entry, small, muted, row, 26); row += 26; }
        if (agentPointer is { } screenPointer)
        {
            var pointer = new Point(screenPointer.X - Left, screenPointer.Y - Top);
            using var accent = new Pen(Color.FromArgb(37, 99, 235), 3);
            using var fill = new SolidBrush(Color.FromArgb(50, 37, 99, 235));
            e.Graphics.FillEllipse(fill, pointer.X - 18, pointer.Y - 18, 36, 36);
            e.Graphics.DrawEllipse(accent, pointer.X - 18, pointer.Y - 18, 36, 36);
            e.Graphics.DrawLine(accent, pointer.X - 6, pointer.Y, pointer.X + 6, pointer.Y);
            e.Graphics.DrawLine(accent, pointer.X, pointer.Y - 6, pointer.X, pointer.Y + 6);
            e.Graphics.DrawString("Agent pointer · last sent", small, ink,
                Math.Clamp(pointer.X + 24, 8, Math.Max(8, ClientSize.Width - 210)), Math.Clamp(pointer.Y + 24, 8, Math.Max(8, ClientSize.Height - 30)));
        }
    }
}
