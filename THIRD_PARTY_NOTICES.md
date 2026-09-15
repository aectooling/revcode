# Third-party notices

Revcode is MIT-licensed; see LICENSE.

Production packages include third-party dependencies with their own licenses. License and notice files from npm dependencies remain under `node_modules`. Node's license and included third-party notices are copied to `runtime/NODE-LICENSE.txt`.

Native dependencies include Microsoft.CodeAnalysis.CSharp (Roslyn), .NET runtime components, NetMQ, AsyncIO, NaCl.Net, and the packages listed by the projects' NuGet dependency graphs. NetMQ is LGPL-3.0 with its additional linking exception; its NuGet/repository license governs that dependency, not Revcode's MIT license. Corresponding upstream sources are available from [NetMQ](https://github.com/zeromq/netmq), [AsyncIO](https://github.com/somdoron/AsyncIO), [NaCl.Net](https://github.com/somdoron/NaCl.net), and [Roslyn](https://github.com/dotnet/roslyn). The native assemblies are shipped as separate DLLs without modification.

MIT License

Copyright (c) 2026 tsoumdoa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
