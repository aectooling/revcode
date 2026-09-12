using System.Text.Json;
using Revcode.Compiler;

var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
try
{
    var input = await Console.In.ReadToEndAsync();
    if (input.Length > 2 * 1024 * 1024) throw new InvalidOperationException("Compiler request exceeds 2 MiB.");
    var request = JsonSerializer.Deserialize<CompileRequest>(input, jsonOptions)
        ?? throw new InvalidOperationException("Missing compiler input.");
    Console.Write(JsonSerializer.Serialize(SnippetCompiler.Compile(request), jsonOptions));
}
catch (Exception ex)
{
    Console.Write(JsonSerializer.Serialize(new CompileResponse(null, null,
        [new("error", ex.Message, null, null)]), jsonOptions));
    Environment.ExitCode = 1;
}
