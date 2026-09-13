using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Revcode.Revit;
using Xunit;

namespace Revcode.Tests
{
    public class BatchExecutorTests
    {
        private static CompiledStep[] Steps => [new("First", [], null), new("Second", [], null), new("Third", [], null)];
        [Fact]
        public void SuccessFlowsJsonAndAssimilatesOnce()
        {
            var doc = new Document();
            ScriptExecutor.Run = (document, prior) => { Assert.Equal(document.Edits, prior.Count); document.Edits++; return Success(); };
            var result = BatchExecutor.Execute(new(), doc, _ => "doc", null, Steps, null, default);
            Assert.Equal("succeeded", result.Status);
            Assert.Equal(3, doc.Edits);
            Assert.Equal(1, doc.UndoItems);
            Assert.All(result.Result!.Value.GetProperty("steps").EnumerateArray(), s => Assert.Equal("committed", s.GetProperty("status").GetString()));
        }
        [Theory]
        [InlineData("failed", false)]
        [InlineData("cancelled", false)]
        [InlineData("unknown", false)]
        [InlineData("failed", true)]
        public void LaterFailureRollsBackOrReportsUnknown(string status, bool cleanupFails)
        {
            var doc = new Document { CleanupFails = cleanupFails };
            ScriptExecutor.Run = (document, prior) => { if (prior.Count > 0) return new(status, null, [], "failure", status == "unknown" ? "Pending" : "RolledBack"); document.Edits++; return Success(); };
            var result = BatchExecutor.Execute(new(), doc, _ => "doc", null, Steps, null, default);
            var unknown = cleanupFails || status == "unknown";
            Assert.Equal(unknown ? "unknown" : status, result.Status);
            Assert.Equal(unknown ? 1 : 0, doc.Edits);
            Assert.Equal(0, doc.UndoItems);
            var receipts = result.Result!.Value.GetProperty("steps");
            Assert.Equal(unknown ? "unknown" : "rolledBack", receipts[0].GetProperty("status").GetString());
            Assert.Equal("notRun", receipts[2].GetProperty("status").GetString());
        }
        [Theory]
        [InlineData("false")]
        [InlineData("1")]
        [InlineData("\"true\"")]
        public void VerificationRequiresBooleanTrue(string value)
        {
            var doc = new Document();
            ScriptExecutor.Run = (document, prior) => { if (prior.Count == 3) return new("succeeded", JsonDocument.Parse(value).RootElement.Clone(), [], null, "NotStarted"); document.Edits++; return Success(); };
            var result = BatchExecutor.Execute(new(), doc, _ => "doc", null, Steps, new("verification", [], null), default);
            Assert.Equal("failed", result.Status);
            Assert.Equal("RolledBack", result.TransactionStatus);
            Assert.Equal(0, doc.Edits);
        }
        [Fact]
        public void AggregateOverflowRollsBackEarlierEdits()
        {
            var doc = new Document();
            ScriptExecutor.Run = (document, _) => { document.Edits++; return new("succeeded", JsonSerializer.SerializeToElement(new string('x', 130000)), [], null, "Committed"); };
            var result = BatchExecutor.Execute(new(), doc, _ => "doc", null, Steps, null, default);
            Assert.Equal("failed", result.Status);
            Assert.Equal(0, doc.Edits);
        }
        private static ExecutionOutcome Success() => new("succeeded", JsonSerializer.SerializeToElement(new { id = "stable-id" }), [], null, "Committed");
    }
}

// Minimal API doubles exercise the actual group coordinator, not Revit transaction semantics.
namespace Autodesk.Revit.UI { internal class UIApplication; }
namespace Autodesk.Revit.DB
{
    internal enum TransactionStatus { Uninitialized, Started, Committed, RolledBack }
    internal class Document { public int Edits; public int UndoItems; public bool CleanupFails; }
    internal class TransactionGroup(Document document, string name) : IDisposable
    {
        private TransactionStatus status;
        public TransactionStatus Start() { _ = name; return status = TransactionStatus.Started; }
        public TransactionStatus GetStatus() => status;
        public TransactionStatus Assimilate() { document.UndoItems++; return status = TransactionStatus.Committed; }
        public TransactionStatus RollBack() { if (document.CleanupFails) throw new Exception("cleanup"); document.Edits = 0; return status = TransactionStatus.RolledBack; }
        public void Dispose() { }
    }
}
namespace Revcode.Revit
{
    internal sealed record CompiledStep(string Name, byte[] Assembly, byte[]? Pdb);
    internal sealed record ExecutionOutcome(string Status, JsonElement? Result, string[] Logs, string? Error, string TransactionStatus);
    internal static class ScriptExecutor
    {
        public static Func<Document, IReadOnlyList<JsonElement>, ExecutionOutcome> Run = null!;
        public static ExecutionOutcome Execute(UIApplication app, Document document, Func<Document, string> token, string mode, string? name,
            byte[] assembly, byte[]? pdb, CancellationToken cancellation, IReadOnlyList<JsonElement> results) => Run(document, results);
    }
}
