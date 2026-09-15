using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace Revcode.Contracts;

public interface IRevcodeScript
{
    object? Execute(RevcodeContext ctx);
}

/// <summary>Valid only during the synchronous Execute callback. Never retain Revit objects.</summary>
public sealed class RevcodeContext(UIApplication uiApp, Document? document, Func<Document, string> documentToken, CancellationToken cancellation, Action<string> logger, IReadOnlyList<System.Text.Json.JsonElement>? stepResults = null)
{
    public IReadOnlyList<System.Text.Json.JsonElement> StepResults => stepResults ?? throw new InvalidOperationException("StepResults is available only in batches.");
    public UIApplication UiApp { get; } = uiApp;
    public UIDocument UiDoc => UiApp.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
    public Document Doc => document ?? throw new InvalidOperationException("No target document. Open or create a document in api mode first.");
    public Document[] Documents => UiApp.Application.Documents.Cast<Document>().Where(x => x.IsValidObject && !x.IsLinked).ToArray();
    public string GetDocumentToken(Document value) => documentToken(value);
    public Document GetDocument(string token) => Documents.SingleOrDefault(x => documentToken(x) == token)
        ?? throw new InvalidOperationException("The requested document is no longer open.");
    public void CheckCancellation() => cancellation.ThrowIfCancellationRequested();
    public void Log(string message) => logger(message);
}
