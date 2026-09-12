# Third-party notices and architecture provenance

Revcode is MIT-licensed; see LICENSE.

The architecture and provider setup flow were studied from [Hoppercode](https://github.com/tsoumdoa/hoppercode) at commit `7dcaf5a1820e5e5d535eaaa35e95abbdad6041c5`, including `docs/shared-host.md`, the browser provider dialog, and the host provider-auth runtime. This prototype independently implements that separation and flow. It does not ship Rhino/Grasshopper code or Autodesk API assemblies.

Production packages include third-party dependencies with their own licenses. License and notice files from npm dependencies remain under `node_modules`. Node's license and included third-party notices are copied to `runtime/NODE-LICENSE.txt`.

Native dependencies include Microsoft.CodeAnalysis.CSharp (Roslyn), .NET runtime components, NetMQ, AsyncIO, NaCl.Net, and the packages listed by the projects' NuGet dependency graphs. NetMQ is LGPL-3.0 with its additional linking exception; its NuGet/repository license governs that dependency, not Revcode's MIT license. Corresponding upstream sources are available from [NetMQ](https://github.com/zeromq/netmq), [AsyncIO](https://github.com/somdoron/AsyncIO), [NaCl.Net](https://github.com/somdoron/NaCl.net), and [Roslyn](https://github.com/dotnet/roslyn). The native assemblies are shipped as separate DLLs without modification.
