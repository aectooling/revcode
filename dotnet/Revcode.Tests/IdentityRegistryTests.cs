using Revcode.Revit;
using Xunit;

namespace Revcode.Tests;

public sealed class IdentityRegistryTests
{
    [Fact]
    public void EquivalentNativeWrappersShareTokenUntilDocumentCloses()
    {
        var registry = new SessionIdentityRegistry<Wrapper>(x => x.Alive);
        var firstWrapper = new Wrapper(1);
        var anotherWrapper = new Wrapper(1);
        Assert.NotSame(firstWrapper, anotherWrapper);
        var token = registry.GetToken(firstWrapper);
        Assert.Equal(token, registry.GetToken(anotherWrapper));
        Assert.NotEqual(token, registry.GetToken(new Wrapper(2)));
        firstWrapper.Alive = false;
        // Reopening a document, even if its native identity is reused, must get a fresh session token.
        Assert.NotEqual(token, registry.GetToken(new Wrapper(1)));
    }

    private sealed class Wrapper(int nativeIdentity)
    {
        public bool Alive { get; set; } = true;
        private int Identity { get; } = nativeIdentity;
        public override bool Equals(object? other) => other is Wrapper wrapper && Identity == wrapper.Identity;
        public override int GetHashCode() => Identity;
    }
}
