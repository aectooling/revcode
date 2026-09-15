namespace Revcode.Revit;

/// <summary>Access only from the owning API thread. Native wrappers may change managed reference identity.</summary>
internal sealed class SessionIdentityRegistry<T>(Func<T, bool> isValid) where T : class
{
    private readonly List<(T Value, string Token)> entries = [];

    public string GetToken(T value)
    {
        entries.RemoveAll(x => !isValid(x.Value));
        foreach (var entry in entries)
            if (EqualityComparer<T>.Default.Equals(entry.Value, value)) return entry.Token;
        var token = Guid.NewGuid().ToString();
        entries.Add((value, token));
        return token;
    }
}
