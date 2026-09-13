using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;

namespace Revcode.Compiler;

public sealed record CompileRequest(string Code, string[]? Usings, string[] References, string Mode = "query");
public sealed record CompileDiagnostic(string Severity, string Message, int? Line, int? Column);
public sealed record CompileResponse(string? Assembly, string? Pdb, CompileDiagnostic[] Diagnostics);

public static class SnippetCompiler
{
    public static CompileResponse Compile(CompileRequest request)
    {
        if (request.Mode is not ("query" or "modify" or "api" or "batch" or "verify")) return Error("Mode must be query, modify, api, batch or verify.");
        if (string.IsNullOrWhiteSpace(request.Code) || Encoding.UTF8.GetByteCount(request.Code) > 65536)
            return Error("Provide a nonempty C# method body of at most 64 KiB.");
        var namespaces = new[] { "System", "System.Linq", "System.Collections.Generic", "Autodesk.Revit.DB", "Autodesk.Revit.UI", "Revcode.Contracts" }
            .Concat(request.Usings ?? []).Distinct().ToArray();
        if (namespaces.Length > 40 || namespaces.Any(x => x.Length > 200 || !System.Text.RegularExpressions.Regex.IsMatch(x, @"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")))
            return Error("Usings must be namespace names, for example System.Text.");
        var source = string.Join("\n", namespaces.Select(x => $"using {x};")) + """

            public sealed class RevcodeSnippet : IRevcodeScript {
                public object? Execute(RevcodeContext ctx) {
            #line 1 "snippet.cs"
            """ + "\n" + request.Code + """

            #line default
                }
            }
            """;
        var tree = CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), new CSharpParseOptions(LanguageVersion.CSharp12));
        var compilation = CSharpCompilation.Create("RevcodeSnippet_" + Guid.NewGuid().ToString("N"), [tree],
            request.References.Distinct(StringComparer.OrdinalIgnoreCase).Select(x => MetadataReference.CreateFromFile(x)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release,
                allowUnsafe: false, nullableContextOptions: NullableContextOptions.Enable));
        var model = compilation.GetSemanticModel(tree);
        var restrictions = new List<CompileDiagnostic>();
        foreach (var node in tree.GetRoot().DescendantNodes())
        {
            string? violation = null;
            if (node is AwaitExpressionSyntax || node is MethodDeclarationSyntax m && m.Modifiers.Any(SyntaxKind.AsyncKeyword)
                || node is AnonymousFunctionExpressionSyntax af && af.AsyncKeyword.IsKind(SyntaxKind.AsyncKeyword))
                violation = "Snippets must execute synchronously; async/await is unsupported.";
            var symbol = node is BaseObjectCreationExpressionSyntax or InvocationExpressionSyntax ? model.GetSymbolInfo(node).Symbol as IMethodSymbol : null;
            var owner = symbol?.ContainingType.ToDisplayString();
            if (owner is "Autodesk.Revit.DB.Transaction" or "Autodesk.Revit.DB.TransactionGroup" or "Autodesk.Revit.DB.SubTransaction")
                violation = "Revcode owns the transaction. Do not create or manage transactions in snippets.";
            if (request.Mode != "api" && (owner == "Autodesk.Revit.DB.Document" && symbol?.Name is "Save" or "SaveAs" or "Close" or "SynchronizeWithCentral" or "Export" or "EditFamily"
                || owner == "Autodesk.Revit.ApplicationServices.Application" && symbol?.Name is "OpenDocumentFile" or "NewProjectDocument" or "NewFamilyDocument"
                || owner == "Autodesk.Revit.UI.UIApplication" && symbol?.Name == "OpenAndActivateDocument"
                || owner == "Autodesk.Revit.DB.Document" && symbol?.Name == "LoadFamily" && symbol.Parameters.FirstOrDefault()?.Type.ToDisplayString() == "Autodesk.Revit.DB.Document"))
                violation = "Use api mode for document lifecycle, export and document-to-document family loading operations.";
            if (owner?.StartsWith("System.Threading.Tasks.Task", StringComparison.Ordinal) == true || owner is "System.Threading.Thread" or "System.Diagnostics.Process")
                violation = "Background tasks, threads and process launches are unsupported in snippets.";
            if (request.Mode is "batch" or "verify")
            {
                if (owner?.StartsWith("System.IO.", StringComparison.Ordinal) == true
                    || owner?.StartsWith("System.Net.", StringComparison.Ordinal) == true
                    || owner == "System.Environment"
                    || owner == "Autodesk.Revit.DB.Document" && symbol?.Name is "LoadFamily" or "LoadFamilySymbol"
                    || owner == "Revcode.Contracts.RevcodeContext" && symbol?.Name == "GetDocument")
                    violation = "Batches permit only transaction-backed edits to ctx.Doc; external effects and other-document access are unsupported.";
                if (node is MemberAccessExpressionSyntax member && model.GetSymbolInfo(member).Symbol is IPropertySymbol property
                    && property.ContainingType.ToDisplayString() == "Revcode.Contracts.RevcodeContext" && property.Name is "UiApp" or "UiDoc" or "Documents")
                    violation = "Use ctx.Doc in batches; UI and other-document access are unsupported.";
            }
            if (violation != null)
            {
                var span = node.GetLocation().GetMappedLineSpan();
                restrictions.Add(new("error", violation, span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1));
            }
        }
        if (restrictions.Count > 0) return new(null, null, restrictions.Take(50).ToArray());
        using var dll = new MemoryStream();
        using var pdb = new MemoryStream();
        var result = compilation.Emit(dll, pdb, options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
        var diagnostics = result.Diagnostics.Where(x => x.Severity is DiagnosticSeverity.Error or DiagnosticSeverity.Warning).Take(50).Select(x =>
        {
            var span = x.Location.GetMappedLineSpan();
            return new CompileDiagnostic(x.Severity.ToString().ToLowerInvariant(), x.GetMessage(),
                x.Location.IsInSource ? span.StartLinePosition.Line + 1 : null,
                x.Location.IsInSource ? span.StartLinePosition.Character + 1 : null);
        }).ToArray();
        return result.Success ? new(Convert.ToBase64String(dll.ToArray()), Convert.ToBase64String(pdb.ToArray()), diagnostics) : new(null, null, diagnostics);
    }

    private static CompileResponse Error(string message) => new(null, null, [new("error", message, null, null)]);
}
