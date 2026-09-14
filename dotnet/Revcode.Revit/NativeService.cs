using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Revcode.Contracts;
using NetMQ;
using NetMQ.Sockets;

namespace Revcode.Revit;

internal sealed class NativeService : IExternalEventHandler, IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string instanceId = Guid.NewGuid().ToString();
    private readonly string root;
    private readonly RuntimeConfig runtime;
    private readonly string[] references;
    private readonly CancellationTokenSource shutdown = new();
    private readonly ExternalEvent externalEvent;
    private readonly SessionIdentityRegistry<Document> documents = new(document => document.IsValidObject);
    private readonly ConcurrentDictionary<string, Operation> operations = new();
    private readonly ConcurrentQueue<Operation> ready = new();
    private readonly object startupLock = new();
    private ContextSnapshot snapshot;
    private Task? startupTask;
    private Discovery? discovery;
    private string? startupError;
    private DateTime lastCapture = DateTime.MinValue;
    private int active;
    private volatile bool fenced;
    private bool disposed;

    public NativeService(UIApplication app)
    {
        root = FindRoot();
        runtime = JsonSerializer.Deserialize<RuntimeConfig>(File.ReadAllText(Path.Combine(root, "runtime.json")), Json)
            ?? throw new InvalidOperationException("Invalid runtime.json.");
        foreach (var path in new[] { runtime.NodePath, runtime.HostPath, runtime.CompilerPath, runtime.DesktopPath })
            if (!File.Exists(ResolvePath(path))) throw new FileNotFoundException("Revcode runtime file missing. Reinstall the package.", path);
        // Capture only assembly paths here; the worker never invokes Revit.
        references = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(x => Path.GetFileName(x).StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                || Path.GetFileName(x) is "System.dll" or "mscorlib.dll" or "netstandard.dll" or "Microsoft.CSharp.dll")
            .Concat([typeof(object).Assembly.Location, typeof(Enumerable).Assembly.Location, typeof(Document).Assembly.Location,
                typeof(UIApplication).Assembly.Location, typeof(RevcodeContext).Assembly.Location]).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        snapshot = Capture(app);
        externalEvent = ExternalEvent.Create(this);
    }

    public void OpenBrowser()
    {
        lock (startupLock)
        {
            if (discovery is { } found) { LaunchBrowser(found); return; }
            if (startupTask is null || startupTask.IsCompleted)
                startupTask = Task.Run(async () =>
                {
                    try { await StartAsync(); }
                    catch (Exception ex) when (!shutdown.IsCancellationRequested) { discovery = null; startupError = ex.Message; }
                });
        }
    }

    public void OnIdling(UIApplication app)
    {
        if (disposed) return;
        if (startupError is { } error)
        {
            startupError = null;
            TaskDialog.Show("Revcode", "Revcode could not start: " + error);
        }
        if ((DateTime.UtcNow - lastCapture).TotalSeconds >= 1)
        {
            try { Volatile.Write(ref snapshot, Capture(app)); lastCapture = DateTime.UtcNow; }
            catch { /* Revit can be transitioning documents; retain the previous immutable snapshot. */ }
        }
        // Idling is a valid API callback. Re-raise on each idle tick, so Pending/coalesced signals cannot strand work.
        if (!ready.IsEmpty && !fenced)
        {
            var result = externalEvent.Raise();
            if (result == ExternalEventRequest.Denied || result == ExternalEventRequest.TimedOut)
            {
                if (ready.TryDequeue(out var operation)) Finish(operation, "failed", "Revit denied the execution event. Retry as a new operation when Revit is idle.");
            }
        }
    }

    private ContextSnapshot Capture(UIApplication app)
    {
        var uiDoc = app.ActiveUIDocument;
        DocumentSnapshot? doc = null;
        if (uiDoc?.Document is { IsValidObject: true } document)
            doc = new(documents.GetToken(document), document.Title, document.IsFamilyDocument, document.IsReadOnly,
                document.ActiveView?.Name ?? "", uiDoc.Selection.GetElementIds().Take(100).Select(x => document.GetElement(x)?.UniqueId ?? "").Where(x => x.Length > 0).ToArray());
        var openDocuments = app.Application.Documents.Cast<Document>().Where(x => x.IsValidObject && !x.IsLinked)
            .Select(x => doc?.Token == documents.GetToken(x) ? doc! : new DocumentSnapshot(documents.GetToken(x), x.Title,
                x.IsFamilyDocument, x.IsReadOnly, "", [])).ToArray();
        return new(instanceId, app.Application.VersionNumber, app.Application.VersionBuild, RuntimeInformation.FrameworkDescription, doc, openDocuments, DateTimeOffset.UtcNow.ToString("O"));
    }

    private async Task StartAsync()
    {
        var userDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Revcode", "user");
        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Revcode", "instances", instanceId);
        MakePrivateDirectory(userDir);
        MakePrivateDirectory(dataDir);
        var discoveryPath = Path.Combine(dataDir, "discovery.json");
        if (File.Exists(discoveryPath)) File.Delete(discoveryPath);
        var nativeToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var start = new ProcessStartInfo(ResolvePath(runtime.NodePath))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = root,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using var parent = Process.GetCurrentProcess();
        foreach (var arg in new[] { ResolvePath(runtime.HostPath), "--instance", instanceId, "--parent-pid", Environment.ProcessId.ToString(),
            "--parent-start-ticks", parent.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "--desktop-path", ResolvePath(runtime.DesktopPath), "--discovery", discoveryPath, "--data-dir", dataDir, "--user-dir", userDir }) start.ArgumentList.Add(arg);
        start.Environment["REVCODE_NATIVE_TOKEN"] = nativeToken;
        using var child = Process.Start(start) ?? throw new InvalidOperationException("Could not launch bundled Node.");
        try
        {
            var logGate = new object();
            var logPath = Path.Combine(dataDir, "host.log");
            void LogLine(object sender, DataReceivedEventArgs args)
            {
                if (args.Data == null || args.Data.Contains(nativeToken, StringComparison.Ordinal)) return;
                try { lock (logGate) { if (!File.Exists(logPath) || new FileInfo(logPath).Length < 2 * 1024 * 1024) File.AppendAllText(logPath, args.Data + Environment.NewLine); } } catch { }
            }
            child.OutputDataReceived += LogLine;
            child.ErrorDataReceived += LogLine;
            child.BeginOutputReadLine(); child.BeginErrorReadLine();
            var timeout = Stopwatch.StartNew();
            Discovery? found = null;
            while (timeout.Elapsed < TimeSpan.FromSeconds(30))
            {
                shutdown.Token.ThrowIfCancellationRequested();
                if (child.HasExited) throw new InvalidOperationException($"Revcode host exited ({child.ExitCode}). See host logs in {dataDir}.");
                if (File.Exists(discoveryPath))
                {
                    try { found = JsonSerializer.Deserialize<Discovery>(await File.ReadAllTextAsync(discoveryPath, shutdown.Token), Json); }
                    catch (JsonException) { }
                    if (found != null) break;
                }
                await Task.Delay(150, shutdown.Token);
            }
            if (found is null || found.ProtocolVersion != 1 || found.InstanceId != instanceId
                || !Uri.TryCreate(found.Url, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || !string.IsNullOrEmpty(uri.UserInfo))
                throw new InvalidOperationException("Host readiness timed out or returned invalid discovery data.");
            if (!Uri.TryCreate(found.NativeEndpoint, UriKind.Absolute, out var nativeUri) || nativeUri.Scheme != "tcp" || nativeUri.Host != "127.0.0.1" || nativeUri.Port <= 0)
                throw new InvalidOperationException("Invalid native ZeroMQ endpoint.");
            discovery = found;
            if (Environment.GetEnvironmentVariable("REVCODE_NO_BROWSER") != "1") LaunchBrowser(found);
            // A dedicated worker owns the Dealer socket. It keeps polling while compiler / API callbacks execute.
            foreach (var operation in operations.Values) operation.AcknowledgedStatus = null;
            await Task.Factory.StartNew(() => TransportLoop(found.NativeEndpoint, nativeToken, child), shutdown.Token,
                TaskCreationOptions.LongRunning, TaskScheduler.Default);
        }
        finally
        {
            // Own only the exact Node Process created above. A failed startup/retry must not leave
            // competing hosts writing the same journal. This continuation runs off Revit's UI thread.
            try
            {
                using var grace = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
                try { await child.WaitForExitAsync(grace.Token); }
                catch (OperationCanceledException) { if (!child.HasExited) child.Kill(); }
            }
            catch { /* Cleanup must never mask the actual startup/transport exception. */ }
        }
    }

    private static void MakePrivateDirectory(string path)
    {
        var directory = Directory.CreateDirectory(path);
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(acl);
    }

    private void TransportLoop(string endpoint, string token, Process host)
    {
        using var socket = new DealerSocket();
        socket.Options.Linger = TimeSpan.Zero;
        socket.Connect(endpoint);
        var heartbeat = DateTime.MinValue;
        while (!shutdown.IsCancellationRequested)
        {
            if (host.HasExited) throw new InvalidOperationException("Revcode host stopped. Click Open Revcode to reconnect; previous operations will not be replayed.");
            try
            {
                if ((DateTime.UtcNow - heartbeat).TotalSeconds >= 1)
                {
                    socket.TrySendFrame(TimeSpan.FromMilliseconds(100), JsonSerializer.Serialize(new { type = "context", token, payload = Volatile.Read(ref snapshot) }, Json));
                    foreach (var operation in operations.Values)
                    {
                        var update = Volatile.Read(ref operation.Update);
                        if (operation.AcknowledgedStatus == update.Status) continue;
                        // Repeat until the host acknowledges journal persistence, not merely socket delivery.
                        socket.TrySendFrame(TimeSpan.FromMilliseconds(100), JsonSerializer.Serialize(new { type = "operation", token, payload = update }, Json));
                    }
                    heartbeat = DateTime.UtcNow;
                }
                if (!socket.TryReceiveFrameString(TimeSpan.FromMilliseconds(100), out var frame)) continue;
                using var message = JsonDocument.Parse(frame);
                var type = message.RootElement.GetProperty("type").GetString();
                if (type == "ack")
                {
                    if (operations.TryGetValue(message.RootElement.GetProperty("operationId").GetString()!, out var acknowledged))
                        acknowledged.AcknowledgedStatus = message.RootElement.GetProperty("status").GetString();
                    continue;
                }
                if (type != "command") continue;
                var command = message.RootElement.GetProperty("command").Deserialize<NativeCommand>(Json);
                if (command != null) AcceptCommand(command);
            }
            catch (Exception) when (!shutdown.IsCancellationRequested) { Thread.Sleep(100); }
        }
        socket.TrySendFrame(TimeSpan.FromMilliseconds(100), JsonSerializer.Serialize(new { type = "disconnect", token }, Json));
    }

    private void AcceptCommand(NativeCommand command)
    {
        if (string.IsNullOrWhiteSpace(command.OperationId)) return;
        if (command.Kind == "cancel") { if (operations.TryGetValue(command.OperationId, out var op)) op.Cancellation.Cancel(); return; }
        if (command.Kind != "execute") return;
        if (operations.TryGetValue(command.OperationId, out var previous)) { previous.AcknowledgedStatus = null; return; }
        // Retain every operation identity for the life of this Revit process; never evict deduplication evidence.
        if (operations.Count >= 1000)
        {
            var rejected = new Operation(command with { Code = null, Usings = null });
            operations.TryAdd(command.OperationId, rejected);
            Finish(rejected, "failed", "Native operation capacity reached; restart Revit.", release: false);
            return;
        }
        var operation = new Operation(command);
        if (!operations.TryAdd(command.OperationId, operation)) return;
        if (fenced) { Finish(operation, "unknown", "Execution is fenced after an unresolved transaction. Restart Revit after inspecting the model."); return; }
        if (Interlocked.CompareExchange(ref active, 1, 0) != 0) { Finish(operation, "failed", "Another native operation is still active.", release: false); return; }
        if (command.Mode == "batch" ? !ValidBatch(command) : command.Mode is not ("query" or "modify" or "api")
            || string.IsNullOrWhiteSpace(command.Code) || command.Mode == "modify" && command.DocumentToken is null
            || command.Steps != null || command.Verify != null)
        { Finish(operation, "failed", "Invalid execution request."); return; }
        _ = CompileAsync(operation);
    }

    private async Task CompileAsync(Operation operation)
    {
        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(operation.Cancellation.Token, shutdown.Token);
            linked.CancelAfter(TimeSpan.FromSeconds(60));
            var snippets = operation.Command.Mode == "batch"
                ? operation.Command.Steps!.Select(s => (s.Name, s.Code, s.Usings, Mode: "batch"))
                    .Concat(operation.Command.Verify is { } verification ? [("verification", verification.Code, verification.Usings, "verify")] : []).ToArray()
                : [(Name: "snippet", Code: operation.Command.Code!, Usings: operation.Command.Usings, Mode: operation.Command.Mode!)];
            var compiled = new List<CompiledStep>();
            var diagnostics = new List<Diagnostic>();
            for (var i = 0; i < snippets.Length; i++)
            {
                var snippet = snippets[i];
                var result = await CompileSnippetAsync(snippet.Code, snippet.Usings, snippet.Mode, linked.Token);
                diagnostics.AddRange(result.Diagnostics.Select(d => operation.Command.Mode == "batch" ? d with { StepIndex = i, StepName = snippet.Name } : d));
                operation.Diagnostics = diagnostics.ToArray();
                if (result.Assembly is null) { Finish(operation, "failed", "C# compilation failed; no steps executed.", transactionStatus: "NotStarted"); return; }
                compiled.Add(new(snippet.Name, Convert.FromBase64String(result.Assembly), result.Pdb is null ? null : Convert.FromBase64String(result.Pdb)));
            }
            if (operation.Command.Mode == "batch")
            {
                operation.Steps = compiled.Take(operation.Command.Steps!.Length).ToArray();
                operation.Verify = operation.Command.Verify is null ? null : compiled[^1];
            }
            else { operation.Assembly = compiled[0].Assembly; operation.Pdb = compiled[0].Pdb; }
            operation.Cancellation.Token.ThrowIfCancellationRequested();
            Volatile.Write(ref operation.Update, new(operation.Command.OperationId, "queued", Diagnostics: operation.Diagnostics));
            ready.Enqueue(operation);
            // Raise is Revit's thread-safe modeless scheduling entry point; no document API is touched here.
            // Relying only on default Idling can stall indefinitely while the user works in the browser.
            var raised = externalEvent.Raise();
            if (raised is ExternalEventRequest.Denied or ExternalEventRequest.TimedOut)
            {
                if (ready.TryDequeue(out var rejected)) Finish(rejected, "failed", "Revit denied the execution event. Retry when Revit is idle.");
            }
        }
        catch (OperationCanceledException) { Finish(operation, operation.Cancellation.IsCancellationRequested || shutdown.IsCancellationRequested ? "cancelled" : "failed", "Compilation cancelled or exceeded 60 seconds."); }
        catch (Exception ex) { Finish(operation, "failed", "Compiler worker failed: " + ex.Message); }
    }

    private static bool ValidBatch(NativeCommand command)
    {
        if (string.IsNullOrWhiteSpace(command.DocumentToken) || command.Steps is not { Length: >= 1 and <= 20 }
            || command.Code != null || command.Usings != null) return false;
        if (command.Steps.Any(s => s is null || string.IsNullOrWhiteSpace(s.Name) || s.Name.Length > 100)) return false;
        var snippets = command.Steps.Select(s => new BatchSnippet(s.Code, s.Usings))
            .Concat(command.Verify is {} verify ? [verify] : []).ToArray();
        return snippets.All(s => !string.IsNullOrWhiteSpace(s.Code) && (s.Usings is null || s.Usings.Length <= 40 && s.Usings.All(u => u != null && u.Length <= 200)))
            && snippets.Sum(s => (long)System.Text.Encoding.UTF8.GetByteCount(s.Code) + (s.Usings ?? []).Sum(u => System.Text.Encoding.UTF8.GetByteCount(u))) <= 65536;
    }

    private async Task<CompileResult> CompileSnippetAsync(string code, string[]? usings, string mode, CancellationToken cancellation)
    {
        var start = new ProcessStartInfo(ResolvePath(runtime.CompilerPath))
        { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root };
        using var worker = Process.Start(start) ?? throw new InvalidOperationException("Could not start compiler worker.");
        using var registration = cancellation.Register(() => { try { if (!worker.HasExited) worker.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } });
        var output = worker.StandardOutput.ReadToEndAsync(cancellation);
        var errors = worker.StandardError.ReadToEndAsync(cancellation);
        await worker.StandardInput.WriteAsync(JsonSerializer.Serialize(new { code, usings, mode, references }, Json).AsMemory(), cancellation);
        worker.StandardInput.Close();
        await worker.WaitForExitAsync(cancellation);
        var result = JsonSerializer.Deserialize<CompileResult>(await output, Json) ?? throw new InvalidOperationException("Compiler returned invalid output.");
        _ = await errors;
        return result;
    }

    public void Execute(UIApplication app)
    {
        if (disposed || fenced || !ready.TryDequeue(out var operation)) return;
        try
        {
            operation.Cancellation.Token.ThrowIfCancellationRequested();
            var current = Capture(app);
            Volatile.Write(ref snapshot, current);
            var document = operation.Command.DocumentToken is { } token
                ? app.Application.Documents.Cast<Document>().SingleOrDefault(x => x.IsValidObject && !x.IsLinked && documents.GetToken(x) == token)
                    ?? throw new InvalidOperationException("The target document is no longer open. Query the open documents before retrying.")
                : null;
            if (document is null && operation.Command.Mode is "modify" or "batch") throw new InvalidOperationException("Modify requires a target document.");
            if (document != null && (document.IsModifiable || document.IsReadOnly && operation.Command.Mode is "modify" or "batch"))
                throw new InvalidOperationException("The document is read-only or already has an active transaction.");
            Volatile.Write(ref operation.Update, new(operation.Command.OperationId, "running", Diagnostics: operation.Diagnostics));
            ExecuteScript(app, document, operation);
            try { Volatile.Write(ref snapshot, Capture(app)); } catch { /* Refresh on next idle after document transitions. */ }
        }
        catch (OperationCanceledException) { Finish(operation, "cancelled", "Execution cancelled before starting."); }
        catch (Exception ex) { Finish(operation, "failed", ex.Message); }
        finally { operation.Assembly = null; operation.Pdb = null; operation.Steps = null; operation.Verify = null; }
    }

    private void ExecuteScript(UIApplication app, Document? document, Operation operation)
    {
        try
        {
            var outcome = operation.Command.Mode == "batch"
                ? BatchExecutor.Execute(app, document!, documents.GetToken, operation.Command.TransactionName, operation.Steps!, operation.Verify, operation.Cancellation.Token)
                : ScriptExecutor.Execute(app, document, documents.GetToken, operation.Command.Mode!, operation.Command.TransactionName,
                operation.Assembly!, operation.Pdb, operation.Cancellation.Token);
            if (outcome.Status == "unknown") fenced = true;
            Finish(operation, outcome.Status, outcome.Error, outcome.Result, outcome.Logs, outcome.TransactionStatus);
        }
        catch (Exception ex)
        {
            // An exception escaping transaction cleanup cannot safely be called a failed/rolled-back edit.
            fenced = true;
            Finish(operation, "unknown", "Execution cleanup failed; inspect the model before continuing: " + ex.Message, transactionStatus: "Unknown");
        }
    }

    private void Finish(Operation operation, string status, string? error = null, JsonElement? result = null, string[]? logs = null, string? transactionStatus = null, bool release = true)
    {
        Volatile.Write(ref operation.Update, new(operation.Command.OperationId, status, result, logs, operation.Diagnostics, error, transactionStatus, operation.Timer.ElapsedMilliseconds));
        if (release) Interlocked.Exchange(ref active, 0);
    }


    private string ResolvePath(string path) => Path.GetFullPath(Path.Combine(root, path));
    private static string FindRoot()
    {
        for (var directory = new DirectoryInfo(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!); directory != null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "runtime.json"))) return directory.FullName;
        throw new FileNotFoundException("runtime.json was not found above the add-in. Run the Revcode package/install script.");
    }

    private static void LaunchBrowser(Discovery found) => Process.Start(new ProcessStartInfo(found.Url.TrimEnd('/') + "/#" + Uri.EscapeDataString(found.BrowserToken)) { UseShellExecute = true });
    public string GetName() => "Revcode synchronous C# executor";

    public void Dispose()
    {
        disposed = true;
        shutdown.Cancel();
        foreach (var operation in operations.Values) operation.Cancellation.Cancel();
        // Do not wait for HTTP or compiler work on Revit's shutdown thread. Node monitors the parent PID.
        externalEvent.Dispose();
    }

    private sealed class Operation(NativeCommand command)
    {
        public NativeCommand Command { get; } = command;
        public CancellationTokenSource Cancellation { get; } = new();
        public Stopwatch Timer { get; } = Stopwatch.StartNew();
        public OperationUpdate Update = new(command.OperationId, "compiling");
        public string? AcknowledgedStatus;
        public Diagnostic[]? Diagnostics;
        public CompiledStep[]? Steps;
        public CompiledStep? Verify;
        public byte[]? Assembly;
        public byte[]? Pdb;
    }
}
