using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Revcode.Desktop;

internal static class Program
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length is not (4 or 5) || (args.Length == 5 && args[4] != "--enable-input")) throw new ArgumentException("Usage: Revcode.Desktop <revit-pid> <revit-start-utc-ticks> <parent-pid> <parent-start-utc-ticks> [--enable-input]");
            using var pump = new Pump(); _ = pump.Handle;
            using var session = new DesktopSession(int.Parse(args[0]), long.Parse(args[1]), int.Parse(args[2]), long.Parse(args[3]), args.Length == 5, pump.Handle);
            pump.Stop = session.Stop;
            pump.FocusHotkey = session.FocusHotkey;
            var output = Channel.CreateBounded<string>(8);
            var writer = Task.Run(async () =>
            {
                try { await foreach (var line in output.Reader.ReadAllAsync()) { await Console.Out.WriteLineAsync(line); await Console.Out.FlushAsync(); } }
                catch { session.RequestStop(); pump.BeginInvoke(Application.ExitThread); }
            });
            var pending = 0; var executing = false;
            void Reply(string? id, object? result, string? error)
            {
                if (!output.Writer.TryWrite(JsonSerializer.Serialize(new { version = 1, requestId = id, generation = session.Generation, result, error }, Json)))
                { session.Stop(); Application.ExitThread(); }
            }
            _ = Task.Run(async () =>
            {
                try
                {
                    using var input = Console.OpenStandardInput();
                    var bytes = new List<byte>(); var buffer = new byte[4096];
                    while (true)
                    {
                        var count = await input.ReadAsync(buffer); if (count == 0) break;
                        for (var i = 0; i < count; i++)
                        {
                            if (buffer[i] != 10)
                            {
                                if (bytes.Count >= 16384) throw new InvalidDataException("Request exceeds 16384 bytes.");
                                bytes.Add(buffer[i]); continue;
                            }
                            var line = new UTF8Encoding(false, true).GetString(bytes.ToArray()); bytes.Clear();
                            var request = JsonSerializer.Deserialize<Request>(line, Json) ?? throw new InvalidDataException("Expected request object.");
                            if (request.Kind == "stop") session.RequestStop();
                            if (Interlocked.Increment(ref pending) > 8) throw new InvalidDataException("Too many pending requests.");
                            pump.BeginInvoke(() =>
                            {
                                Interlocked.Decrement(ref pending);
                                if (executing && request.Kind is not ("stop" or "heartbeat")) { Reply(request.RequestId, null, "Another request is running."); return; }
                                var previous = executing; executing = true;
                                try { Reply(request.RequestId, session.Handle(request), null); }
                                catch (Exception error) { Reply(request.RequestId, null, error.Message); }
                                finally { executing = previous; }
                            });
                        }
                    }
                }
                catch (Exception error) { Console.Error.WriteLine(error.Message); }
                finally { session.RequestStop(); pump.BeginInvoke(() => { session.Stop(); Application.ExitThread(); }); }
            });
            using var timer = new System.Windows.Forms.Timer { Interval = 100 };
            timer.Tick += (_, _) => session.Tick(); timer.Start();
            Application.Run(); output.Writer.TryComplete();
            // A disconnected/blocked parent must not keep input ownership alive.
            writer.Wait(TimeSpan.FromSeconds(1));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }

    private sealed class Pump : Control
    {
        public Action? Stop;
        public Action? FocusHotkey;
        protected override void WndProc(ref System.Windows.Forms.Message message)
        {
            if (message.Msg == 0x0312 && message.WParam == 1) Stop?.Invoke();
            if (message.Msg == 0x0312 && message.WParam == Win32.FocusHotkeyId) FocusHotkey?.Invoke();
            base.WndProc(ref message);
        }
    }
}
