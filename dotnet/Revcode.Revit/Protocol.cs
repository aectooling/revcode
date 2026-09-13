using System.Text.Json;

namespace Revcode.Revit;

internal sealed record DocumentSnapshot(string Token, string Title, bool IsFamily, bool IsReadOnly, string ActiveView, string[] Selection);
internal sealed record ContextSnapshot(string InstanceId, string RevitVersion, string RevitBuild, string Runtime, DocumentSnapshot? Document, DocumentSnapshot[] Documents);
internal sealed record NativeCommand(string Kind, string OperationId, string? DocumentToken, string? Code, string[]? Usings, string? Mode, string? TransactionName, BatchStep[]? Steps = null, BatchSnippet? Verify = null);
internal sealed record BatchSnippet(string Code, string[]? Usings);
internal sealed record BatchStep(string Name, string Code, string[]? Usings);
internal sealed record CompiledStep(string Name, byte[] Assembly, byte[]? Pdb);
internal sealed record Diagnostic(string Severity, string Message, int? Line, int? Column, int? StepIndex = null, string? StepName = null);
internal sealed record CompileResult(string? Assembly, string? Pdb, Diagnostic[] Diagnostics);
internal sealed record OperationUpdate(string OperationId, string Status, JsonElement? Result = null, string[]? Logs = null,
    Diagnostic[]? Diagnostics = null, string? Error = null, string? TransactionStatus = null, long? ElapsedMs = null);
internal sealed record Discovery(int ProtocolVersion, string InstanceId, string Url, string BrowserToken, string NativeEndpoint);
internal sealed record RuntimeConfig(string NodePath, string HostPath, string CompilerPath);
