using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Revcode.Desktop;

// Full-screen visual curtain. Keep Revit focused and let agent input pass through.
// This is not an OS lock; the registered emergency-stop shortcut remains available.
internal sealed class ControlNotice : Form
{
    private bool waiting;
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
        if (!Visible) Show();
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
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
    }
}
