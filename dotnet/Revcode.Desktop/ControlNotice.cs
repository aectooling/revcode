namespace Revcode.Desktop;

// A click-through, non-activating notice stays visible when chat is behind Revit.
// It never owns focus or intercepts the user's emergency-stop shortcut.
internal sealed class ControlNotice : Form
{
    private readonly Label label = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White };
    public ControlNotice()
    {
        Text = "Revcode desktop control";
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
        StartPosition = FormStartPosition.Manual; BackColor = Color.FromArgb(38, 46, 63);
        Opacity = 0.94; Font = new Font("Segoe UI", 10, FontStyle.Bold);
        Controls.Add(label);
    }
    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get { var value = base.CreateParams; value.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020; return value; }
    }
    public void Display(nint target, bool waiting)
    {
        var area = Screen.FromHandle(target).WorkingArea;
        var width = Math.Min(660, area.Width);
        Bounds = new Rectangle(area.Right - width - 8, area.Bottom - 64, width, 56);
        label.Text = waiting
            ? "Revcode is waiting for you to release the mouse and keyboard.\nWill retry shortly · Ctrl+Alt+F12 to stop"
            : "Revcode is using the mouse and keyboard — please don't touch them.\nCtrl+Alt+F12 to stop";
        if (!Visible) Show();
    }
}
