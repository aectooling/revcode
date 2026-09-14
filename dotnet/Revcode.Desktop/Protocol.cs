using System.Text.Json;

namespace Revcode.Desktop;

public sealed record Bounds(int X, int Y, int Width, int Height)
{
    public bool Contains(int x, int y) => x >= X && y >= Y && (long)x < (long)X + Width && (long)y < (long)Y + Height;
}

public static class Coordinates
{
    public static (int X, int Y) Map(Bounds crop, int imageWidth, int imageHeight, double x, double y)
    {
        if (crop.Width <= 0 || crop.Height <= 0 || imageWidth <= 0 || imageHeight <= 0 ||
            !double.IsFinite(x) || !double.IsFinite(y) || x < 0 || y < 0 || x >= imageWidth || y >= imageHeight)
            throw new ArgumentException("Point is outside the observation.");
        return (checked(crop.X + (int)Math.Floor(x * crop.Width / imageWidth)), checked(crop.Y + (int)Math.Floor(y * crop.Height / imageHeight)));
    }

    public static (int X, int Y) Normalize(Bounds desktop, int x, int y)
    {
        if (desktop.Width < 2 || desktop.Height < 2 || !desktop.Contains(x, y)) throw new ArgumentException("Point is outside the virtual desktop.");
        return ((int)Math.Round(((double)x - desktop.X) * 65535 / (desktop.Width - 1)),
                (int)Math.Round(((double)y - desktop.Y) * 65535 / (desktop.Height - 1)));
    }
}

public sealed record Request(int Version, string RequestId, string Kind, string? Generation = null,
    string? ObservationId = null, string? Action = null, double? X = null, double? Y = null,
    string? Text = null, string[]? Keys = null, string? Direction = null, int? Notches = null,
    string? WindowRef = null, Bounds? Crop = null, int MaxWidth = 1600);

public sealed record Receipt(string Status, int Inserted = 0, string? Error = null, bool? Owned = null, string? Recovery = null);

// Retain every receipt for this generation. Refuse new actions when full rather than
// evicting IDs and accidentally turning a retry into another physical action.
public sealed class DispatchLedger(int capacity = 1024)
{
    private readonly Dictionary<string, (string Fingerprint, Receipt Receipt)> entries = new();
    public Receipt? Find(Request request)
    {
        if (!entries.TryGetValue(request.RequestId, out var old)) return null;
        if (old.Fingerprint != JsonSerializer.Serialize(request)) throw new InvalidOperationException("Request ID already used for different content.");
        return old.Receipt;
    }
    public void Begin(Request request)
    {
        if (entries.Count >= capacity) throw new InvalidOperationException("Dispatch ledger full; restart after reviewing receipts.");
        entries.Add(request.RequestId, (JsonSerializer.Serialize(request), new Receipt("unknown", Error: "Dispatch started without a receipt.")));
    }
    public void Complete(Request request, Receipt receipt) => entries[request.RequestId] = (JsonSerializer.Serialize(request), receipt);
}
