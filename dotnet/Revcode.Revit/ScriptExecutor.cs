using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Revcode.Contracts;

namespace Revcode.Revit;

internal sealed record ExecutionOutcome(string Status, JsonElement? Result, string[] Logs, string? Error, string TransactionStatus);

internal static class ScriptExecutor
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static ExecutionOutcome Execute(UIApplication app, Document? document, Func<Document, string> documentToken, string mode, string? transactionName, byte[] assembly, byte[]? pdb, CancellationToken cancellation)
    {
        var loadContext = new SnippetLoadContext();
        Transaction? transaction = null;
        var logs = new List<string>();
        var logChars = 0;
        var transactionStatus = "NotStarted";
        var scriptStarted = false;
        try
        {
            using var dllStream = new MemoryStream(assembly);
            using var pdbStream = pdb is null ? null : new MemoryStream(pdb);
            var scriptAssembly = loadContext.LoadFromStream(dllStream, pdbStream);
            var script = (IRevcodeScript)Activator.CreateInstance(scriptAssembly.GetType("RevcodeSnippet", throwOnError: true)!)!;
            cancellation.ThrowIfCancellationRequested();
            if (mode == "modify")
            {
                transaction = new Transaction(document ?? throw new InvalidOperationException("Modify requires a target document."), "Revcode: " + (string.IsNullOrWhiteSpace(transactionName) ? "C# edit" : transactionName[..Math.Min(100, transactionName.Length)]));
                if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start the Revit transaction.");
                transactionStatus = "Started";
                transaction.SetFailureHandlingOptions(transaction.GetFailureHandlingOptions()
                    .SetFailuresPreprocessor(new FailureCollector(logs)).SetClearAfterRollback(true).SetForcedModalHandling(true));
            }
            var context = new RevcodeContext(app, document, documentToken, cancellation, text =>
            {
                if (logs.Count >= 100 || logChars >= 16000) return;
                var line = text[..Math.Min(text.Length, Math.Min(2000, 16000 - logChars))];
                logs.Add(line); logChars += line.Length;
            });
            scriptStarted = true;
            var value = script.Execute(context);
            cancellation.ThrowIfCancellationRequested();
            // Serialize in API context before commit, so invalid return values roll back edits.
            var options = new JsonSerializerOptions { MaxDepth = 16 };
            options.Converters.Add(new RejectNativeObjects());
            using var stream = new LimitedStream(256 * 1024);
            JsonSerializer.Serialize(stream, value, value?.GetType() ?? typeof(object), options);
            using var json = JsonDocument.Parse(stream.ToArray());
            var result = json.RootElement.Clone();
            if (transaction != null)
            {
                var status = transaction.Commit();
                transactionStatus = status.ToString();
                if (status == TransactionStatus.Pending) return new("unknown", null, logs.ToArray(), "Revit transaction is pending. Inspect the model before further execution.", transactionStatus);
                if (status != TransactionStatus.Committed) return new("failed", null, logs.ToArray(), "Revit rolled back the transaction during failure handling.", transactionStatus);
            }
            return new("succeeded", result, logs.ToArray(), null, mode == "api" ? "ApiManaged" : transactionStatus);
        }
        catch (Exception ex)
        {
            if (mode == "api" && scriptStarted)
                return new("unknown", null, logs.ToArray(), ex.GetBaseException().Message + "; API operations may already have taken effect. Inspect Revit before continuing.", "Unknown");
            try
            {
                if (transaction?.GetStatus() == TransactionStatus.Started) transactionStatus = transaction.RollBack().ToString();
                else if (transaction != null) transactionStatus = transaction.GetStatus().ToString();
            }
            catch (Exception rollbackError)
            {
                return new("unknown", null, logs.ToArray(), ex.Message + "; rollback could not be confirmed: " + rollbackError.Message, "Unknown");
            }
            if (transaction != null && transactionStatus is not ("RolledBack" or "Uninitialized"))
                return new("unknown", null, logs.ToArray(), ex.Message + "; transaction outcome requires inspection.", transactionStatus);
            return new(ex is OperationCanceledException ? "cancelled" : "failed", null, logs.ToArray(), ex.GetBaseException().Message, transactionStatus);
        }
        finally
        {
            // Pending transactions must not be reported as successful. The native service fences execution.
            if (transaction != null && transaction.GetStatus() != TransactionStatus.Pending) transaction.Dispose();
            loadContext.Unload();
        }
    }

    private sealed class SnippetLoadContext() : AssemblyLoadContext(isCollectible: true)
    {
        protected override Assembly? Load(AssemblyName name)
        {
            foreach (var shared in new[] { typeof(Document).Assembly, typeof(UIApplication).Assembly, typeof(RevcodeContext).Assembly })
                if (AssemblyName.ReferenceMatchesDefinition(shared.GetName(), name)) return shared;
            return null; // BCL resolves through the default context; no private Revit/contract duplicates.
        }
    }

    private sealed class FailureCollector(List<string> logs) : IFailuresPreprocessor
    {
        public FailureProcessingResult PreprocessFailures(FailuresAccessor failuresAccessor)
        {
            var errors = false;
            foreach (var failure in failuresAccessor.GetFailureMessages())
            {
                if (logs.Count < 100) logs.Add(failure.GetDescriptionText()[..Math.Min(1000, failure.GetDescriptionText().Length)]);
                if (failure.GetSeverity() == FailureSeverity.Warning) failuresAccessor.DeleteWarning(failure);
                else errors = true;
            }
            return errors ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
        }
    }

    private sealed class RejectNativeObjects : JsonConverterFactory
    {
        public override bool CanConvert(Type type) => type.Namespace?.StartsWith("Autodesk.Revit", StringComparison.Ordinal) == true
            || typeof(MemberInfo).IsAssignableFrom(type) || typeof(Delegate).IsAssignableFrom(type)
            || typeof(Task).IsAssignableFrom(type);
        public override JsonConverter CreateConverter(Type type, JsonSerializerOptions options) => throw new InvalidOperationException(
            "Return JSON-safe values (strings, numbers, arrays, anonymous objects), not Revit objects, delegates or tasks.");
    }

    private sealed class LimitedStream(int limit) : MemoryStream
    {
        public override void Write(byte[] buffer, int offset, int count)
        {
            if (Length + count > limit) throw new InvalidOperationException("Result exceeds 256 KiB. Return a smaller, materialized result.");
            base.Write(buffer, offset, count);
        }
        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (Length + buffer.Length > limit) throw new InvalidOperationException("Result exceeds 256 KiB. Return a smaller, materialized result.");
            base.Write(buffer);
        }
    }
}
