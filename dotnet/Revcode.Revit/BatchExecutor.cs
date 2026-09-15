using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace Revcode.Revit;

/// <summary>All work, including verification and group cleanup, stays in one API callback.</summary>
internal static class BatchExecutor
{
    private sealed record StepReceipt(string Name, string Status, JsonElement? Result = null, string? Error = null);

    public static ExecutionOutcome Execute(UIApplication app, Document document, Func<Document, string> token,
        string? name, CompiledStep[] steps, CompiledStep? verify, CancellationToken cancellation)
    {
        var receipts = steps.Select(s => new StepReceipt(s.Name, "notRun")).ToArray();
        var results = new List<JsonElement>();
        var logs = new List<string>();
        var logChars = 0;
        var resultBytes = 0;
        var group = new TransactionGroup(document, "Revcode: " + (string.IsNullOrWhiteSpace(name) ? "Atomic batch" : name[..Math.Min(100, name.Length)]));
        var uncertain = false;
        string? verificationStatus = verify is null ? null : "notRun";
        JsonElement Payload() => JsonSerializer.SerializeToElement(new { steps = receipts, verificationStatus }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        void AddLogs(string[] lines)
        {
            foreach (var line in lines)
            {
                if (logs.Count >= 100 || logChars >= 16000) break;
                var bounded = line[..Math.Min(line.Length, 16000 - logChars)];
                logs.Add(bounded); logChars += bounded.Length;
            }
        }
        try
        {
            cancellation.ThrowIfCancellationRequested();
            if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start batch transaction group.");
            for (var i = 0; i < steps.Length; i++)
            {
                cancellation.ThrowIfCancellationRequested();
                var step = steps[i];
                receipts[i] = new(step.Name, "running");
                var outcome = ScriptExecutor.Execute(app, document, token, "modify", step.Name, step.Assembly, step.Pdb, cancellation, results.AsReadOnly());
                AddLogs(outcome.Logs);
                receipts[i] = new(step.Name, "executed", outcome.Result, outcome.Error is { } stepError ? stepError[..Math.Min(2000, stepError.Length)] : null);
                if (outcome.Status != "succeeded" || outcome.TransactionStatus != "Committed")
                {
                    uncertain = outcome.Status == "unknown";
                    if (outcome.Status == "cancelled") throw new OperationCanceledException(outcome.Error, cancellation);
                    throw new InvalidOperationException(outcome.Error ?? "Inner transaction did not commit.");
                }
                var result = outcome.Result ?? JsonSerializer.SerializeToElement<object?>(null);
                resultBytes += System.Text.Encoding.UTF8.GetByteCount(result.GetRawText());
                if (resultBytes > 240 * 1024) throw new InvalidOperationException("Aggregate batch results exceed the payload budget.");
                results.Add(result);
            }
            if (verify != null)
            {
                verificationStatus = "running";
                var outcome = ScriptExecutor.Execute(app, document, token, "query", null, verify.Assembly, verify.Pdb, cancellation, results.AsReadOnly());
                AddLogs(outcome.Logs);
                verificationStatus = "failed";
                if (outcome.Status == "cancelled") throw new OperationCanceledException(outcome.Error, cancellation);
                if (outcome.Status != "succeeded" || outcome.Result?.ValueKind != JsonValueKind.True)
                    throw new InvalidOperationException(outcome.Error ?? "Batch verification must return exactly true.");
                verificationStatus = "passed";
            }
            cancellation.ThrowIfCancellationRequested();
            // Prepare the complete success payload before the irreversible group finalization.
            for (var i = 0; i < receipts.Length; i++) receipts[i] = receipts[i] with { Status = "committed" };
            var payload = Payload();
            if (System.Text.Encoding.UTF8.GetByteCount(payload.GetRawText()) > 256 * 1024)
                throw new InvalidOperationException("Batch result exceeds 256 KiB.");
            cancellation.ThrowIfCancellationRequested();
            if (group.Assimilate() != TransactionStatus.Committed) throw new InvalidOperationException("Batch assimilation did not confirm commitment.");
            return new("succeeded", payload, logs.ToArray(), null, "Committed");
        }
        catch (Exception error)
        {
            var status = "Unknown";
            try
            {
                // Never close a group over a pending inner transaction.
                if (!uncertain)
                {
                    var current = group.GetStatus();
                    status = (current == TransactionStatus.Started ? group.RollBack() : current).ToString();
                    uncertain = status is not ("RolledBack" or "Uninitialized");
                }
            }
            catch { uncertain = true; }
            for (var i = 0; i < receipts.Length; i++)
                if (receipts[i].Status != "notRun") receipts[i] = receipts[i] with { Status = uncertain ? "unknown" : "rolledBack", Result = null };
            return new(uncertain ? "unknown" : error is OperationCanceledException ? "cancelled" : "failed",
                Payload(), logs.ToArray(), error.GetBaseException().Message[..Math.Min(2000, error.GetBaseException().Message.Length)], status);
        }
        finally
        {
            // Unknown cleanup fences the service; disposing an unresolved group can itself throw.
            if (!uncertain) group.Dispose();
        }
    }
}
