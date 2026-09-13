using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Revcode.Compiler;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using Xunit;

namespace Revcode.Tests;

public sealed class CompilerTests : IDisposable
{
    private readonly string folder = Path.Combine(Path.GetTempPath(), "Revcode.CompilerTests", Guid.NewGuid().ToString("N"));
    private readonly string[] references;

    public CompilerTests()
    {
        Directory.CreateDirectory(folder);
        var bcl = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator);
        var stub = CSharpCompilation.Create("TestContract", [CSharpSyntaxTree.ParseText("""
            namespace Autodesk.Revit.DB { public class Document { public void Save() {} public void LoadFamily(Document target) {} public void LoadFamily(string path) {} } public class Transaction { public Transaction(Document doc) {} } }
            namespace Autodesk.Revit.UI { public class UIApplication {} }
            namespace Revcode.Contracts {
                public class RevcodeContext { public Autodesk.Revit.DB.Document Doc => new(); public void CheckCancellation() {} }
                public interface IRevcodeScript { object Execute(RevcodeContext ctx); }
            }
            """)], bcl.Select(x => MetadataReference.CreateFromFile(x)), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var path = Path.Combine(folder, "TestContract.dll");
        using (var stream = File.Create(path)) Assert.True(stub.Emit(stream).Success);
        references = [.. bcl, path];
    }

    [Fact]
    public void CompilesAnonymousMaterializedResultAndPortableSymbols()
    {
        var result = Compile("return new [] { 1, 2 }.Select(x => new { number = x }).ToArray();");
        Assert.NotNull(result.Assembly);
        Assert.NotNull(result.Pdb);
        Assert.DoesNotContain(result.Diagnostics, x => x.Severity == "error");
    }

    [Theory]
    [InlineData("batch")]
    [InlineData("verify")]
    public void BatchContractsRejectKnownExternalEffects(string mode)
    {
        Assert.NotNull(SnippetCompiler.Compile(new("return true;", null, references, mode)).Assembly);
        foreach (var code in new[] { "ctx.Doc.Save(); return true;", "ctx.Doc.LoadFamily(\"family.rfa\"); return true;", "System.IO.File.WriteAllText(\"test\", \"data\"); return true;", "return System.Net.Dns.GetHostName();" })
            Assert.Null(SnippetCompiler.Compile(new(code, null, references, mode)).Assembly);
    }

    [Fact]
    public void ErrorsMapToSnippetLine()
    {
        var result = Compile("var count = 1;\nreturn missingIdentifier;");
        Assert.Null(result.Assembly);
        Assert.Contains(result.Diagnostics, x => x.Severity == "error" && x.Line == 2 && x.Message.Contains("missingIdentifier"));
    }

    [Theory]
    [InlineData("using var tx = new Transaction(ctx.Doc); return null;")]
    [InlineData("Transaction tx = new(ctx.Doc); return null;")]
    [InlineData("ctx.Doc.Save(); return null;")]
    [InlineData("System.Threading.Tasks.Task.Run(() => 1); return null;")]
    [InlineData("await System.Threading.Tasks.Task.Delay(1); return null;")]
    public void RejectsUnsupportedExecutionPatterns(string code)
    {
        var result = Compile(code);
        Assert.Null(result.Assembly);
        Assert.Contains(result.Diagnostics, x => x.Severity == "error");
    }

    [Fact]
    public void RejectsNamespaceInjectionAndOversizedSource()
    {
        Assert.Null(SnippetCompiler.Compile(new("return 1;", ["System; class Escape {}"], references)).Assembly);
        Assert.Null(Compile(new string(' ', 65536) + "return 1;").Assembly);
    }

    [Fact]
    public void AllowsDocumentOperationsOnlyInApiModeButStillOwnsTransactions()
    {
        foreach (var code in new[] { "ctx.Doc.Save(); return null;", "ctx.Doc.LoadFamily(ctx.Doc); return null;" })
        {
            Assert.NotNull(SnippetCompiler.Compile(new(code, null, references, "api")).Assembly);
            Assert.Null(SnippetCompiler.Compile(new(code, null, references, "modify")).Assembly);
            Assert.Null(Compile(code).Assembly);
        }
        Assert.NotNull(SnippetCompiler.Compile(new("ctx.Doc.LoadFamily(\"family.rfa\"); return null;", null, references, "modify")).Assembly);
        Assert.Null(SnippetCompiler.Compile(new("var tx = new Transaction(ctx.Doc); return null;", null, references, "api")).Assembly);
        Assert.Null(SnippetCompiler.Compile(new("return 1;", null, references, "invalid")).Assembly);
    }

    [Fact]
    public void CompiledAssembliesCanBeUnloadedRepeatedly()
    {
        var compiled = Compile("return 42;");
        Assert.NotNull(compiled.Assembly);
        var weak = Enumerable.Range(0, 20).Select(_ => LoadAndRelease(Convert.FromBase64String(compiled.Assembly), references[^1])).ToArray();
        for (var attempt = 0; attempt < 10 && weak.Any(x => x.IsAlive); attempt++)
        { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); }
        Assert.All(weak, x => Assert.False(x.IsAlive));
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference LoadAndRelease(byte[] bytes, string contractPath)
    {
        var context = new AssemblyLoadContext(null, isCollectible: true);
        context.LoadFromAssemblyPath(contractPath);
        using var stream = new MemoryStream(bytes);
        var assembly = context.LoadFromStream(stream);
        var instance = Activator.CreateInstance(assembly.GetType("RevcodeSnippet")!);
        Assert.Equal(42, instance!.GetType().GetMethod("Execute")!.Invoke(instance, [null]));
        var weak = new WeakReference(context);
        context.Unload();
        return weak;
    }

    private CompileResponse Compile(string code) => SnippetCompiler.Compile(new(code, null, references));
    public void Dispose() => Directory.Delete(folder, recursive: true);
}
