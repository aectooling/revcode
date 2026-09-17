# Package size

The browser build is tree-shaken by Vite. The release payload is larger because
it also includes Node, production npm dependencies, self-contained .NET compiler
and desktop helpers, and the selected Revit add-ins. `tsc` compiles the host;
it does not bundle or tree-shake its dependencies.

## Measured reduction

These measurements compare unsigned Revit 2026 / .NET 10 packages built from the
0.1.1 source with Node 22.22.3. MiB means 1,048,576 bytes. Other Revit target
combinations add their own add-in files; timings and archive sizes can vary.

| Component | Before (MiB) | After (MiB) |
| --- | ---: | ---: |
| Production node_modules | 139.77 | 66.08 |
| Compiler helper | 92.30 | 92.30 |
| Desktop helper | 117.05 | 117.05 |
| Bundled Node and license | 83.08 | 83.08 |
| Revit 2026 add-in | 5.57 | 5.57 |
| Host and browser dist | 1.75 | 1.75 |
| Total installed payload, including metadata/docs | 441.97 | 367.20 |
| Compressed payload.zip | 163.96 | 142.92 |
| Payload file count | 14,917 | 6,918 |

Installed bytes decrease by approximately 16.9%, and the ZIP by 12.8%. The npm
tarball wraps the ZIP and installer; its package-manager “unpacked size” is not
the size of the installed application. The optimized tarball measured about
148 MB (decimal), including its installer.

Packaging now removes only dependency JavaScript/declaration source maps,
TypeScript declarations, and ZeroMQ native binaries for other operating systems
or architectures. The measured removals are 40.19 MiB, 16.14 MiB, and 17.36 MiB
respectively. The smaller integrity inventory accounts for most of the remaining
savings. Both Windows x64 ZeroMQ variants and their loader/manifest are retained.

Runtime JavaScript, TypeScript source files, dynamic provider modules, workers,
WASM, model data, package metadata, licenses and notices remain present. Revcode's
own host source maps are retained. Dependency stack traces remain available, but
mapping third-party stack traces back to their original sources requires the
unpruned dependency package.

## Browser tree-shaking

Inspection of Vite's emitted chunk module lists found 32 Lucide icon modules,
not the complete icon catalog. Shiki includes only C# and JSON grammars, one theme,
and its Oniguruma engine. Highlighting is loaded separately. The largest emitted
pieces are the application bundle (about 613 kB), the highlighter (198 kB), and
the inlined WASM chunk (622 kB). These are uncompressed decimal sizes.

The existing large-chunk warning is a browser loading concern, not evidence that
the release ships all 2,271 transformed modules. Changing chunk boundaries would
not materially shrink the hundreds of MiB of runtimes and host dependencies.

## Why not bundle everything or trim .NET here?

Pi's OAuth loader deliberately uses variable dynamic imports. Its image worker
and provider data also resolve paths relative to their installed modules. A host
bundle needs explicit support for these assets and entry points; basic bundler
success alone would not establish that all providers still work.

The helpers have about 76.31 MiB of byte-identical files in common. A shared helper
directory/runtime could reduce this further, but changes the deployment layout
and requires compiler, desktop, installer and upgrade compatibility validation.
This change preserves their existing independent self-contained deployments.
Likewise, .NET trimming needs separate analysis for Roslyn's dynamic compilation
and Windows Forms; it is not enabled by a blanket size setting.

Old versioned installations and retained rollback packages are a separate source
of disk usage. This packaging change does not delete existing installations,
history or user data.

## Repeat the measurements and checks

`scripts/package.ps1` prunes only a newly staged payload before its integrity
inventory is generated. It refuses links, missing Windows x64 ZeroMQ binaries,
and payloads that already contain `integrity.json`. It then smoke-tests bundled
ZeroMQ and runs the existing tests with host imports redirected to the staged
compiled host and its production dependencies. Failures stop packaging.

The resulting distribution directory includes a build-only `size-report.json`
with total bytes, file counts, per-component sizes and ZIP bytes. It is excluded
from the published npm package. To inspect an existing build:

```powershell
node scripts/deployment/measure-payload.mjs artifacts/my-payload artifacts/my-payload-npm/payload.zip
$env:REVCODE_TEST_PAYLOAD = (Resolve-Path artifacts/my-payload).Path
pnpm run test:payload
Remove-Item Env:REVCODE_TEST_PAYLOAD
```

Validation includes production package builds, staged-host tests (real Pi SDK
against local model fixtures), pruning/installer tests, bundled-host stop/restart,
and offline tarball installation through npm and pnpm with lifecycle scripts both
enabled and disabled. Tarball tests use isolated profile directories and start
bundled Node/ZeroMQ and both helpers. They do not edit a live Revit model or use
desktop input.
