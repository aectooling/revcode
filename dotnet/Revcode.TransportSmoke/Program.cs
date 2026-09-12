using System.Collections.Immutable;
using NetMQ;
using NetMQ.Sockets;

// Force the same BCL identity already loaded by .NET 8 Revit before constructing NetMQ.
Console.WriteLine(typeof(ImmutableArray<>).Assembly.FullName);
using var router = new RouterSocket();
using var dealer = new DealerSocket();
router.Options.Linger = TimeSpan.Zero;
dealer.Options.Linger = TimeSpan.Zero;
var port = router.BindRandomPort("tcp://127.0.0.1");
dealer.Connect($"tcp://127.0.0.1:{port}");
dealer.SendFrame("probe");
var incoming = new NetMQMessage();
if (!router.TryReceiveMultipartMessage(TimeSpan.FromSeconds(5), ref incoming) || incoming.FrameCount != 2 || incoming[1].ConvertToString() != "probe")
    throw new InvalidOperationException("Dealer/Router outbound exchange failed.");
router.SendMoreFrame(incoming[0].Buffer).SendFrame("ack");
if (!dealer.TryReceiveFrameString(TimeSpan.FromSeconds(5), out var response) || response != "ack")
    throw new InvalidOperationException("Dealer/Router reply exchange failed.");
Console.WriteLine("PASS: NetMQ Dealer/Router exchange under .NET 8 with Immutable 8 already loaded.");
