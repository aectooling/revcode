using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace Revcode.Contracts;

public interface IRevcodeScript
{
    object? Execute(RevcodeContext ctx);
}

/// <summary>Valid only during the synchronous Execute callback. Never retain Revit objects.</summary>
public sealed class RevcodeContext(UIApplication uiApp, CancellationToken cancellation, Action<string> logger)
{
    public UIApplication UiApp { get; } = uiApp;
    public UIDocument UiDoc => UiApp.ActiveUIDocument;
    public Document Doc => UiDoc.Document;
    public void CheckCancellation() => cancellation.ThrowIfCancellationRequested();
    public void Log(string message) => logger(message);
}
