# Deployment and releases with pnpm

Status: implemented commands; the initial release is configured as unsigned. Public release remains gated on all API references, automated artifact checks, and maintainer account setup. Windows x64 only; no MSI. The repository package stays private. Only the generated distribution package is publishable.

## Compatibility

`release.config.json` is the target policy. This release supports Revit 2025 on .NET 8 only; its .NET 10 variant is deferred to a future release after matching references and live testing are available. Revit 2026 requires .NET 10 and build 26.5.0.55 or newer; Revit 2027 uses .NET 10. Installation checks the installed executable build and `RevitAPI.runtimeconfig.json`, including registry-discovered custom installation paths. Unknown runtimes remain pending. Selecting a year does not override compatibility.

Build each variant against matching Autodesk references. The package records their build, checksum, runtime configuration, and target. The built API version is the conservative minimum supported build: older builds require rebuilding against older references and acceptance testing. No API DLLs are redistributed. Live testing of all three targets is recommended; a manual acceptance file is not required to publish. A runtime change requires revalidation, even within the same Revit year.

Autodesk references:

- [2025/2026 .NET migration](https://aps.autodesk.com/blog/call-preview-testing-revit-20262025-migration-net-10)
- [2026.5 build and runtime](https://help.autodesk.com/view/RVT/2026/ENU/?guid=RevitReleaseNotes_2026updates_2026_5_html)
- [2027 runtime](https://help.autodesk.com/cloudhelp/2027/ENU/Revit-WhatsNew/files/GUID-8D7A4715-EAF8-4BD1-BE78-061F900D0BCE.htm)

## User installation after publication

The public npm package is `@aectooling/revcode`; the CLI command remains `revcode`.
The scoped release starts at 0.1.1 because the abandoned unscoped candidate already
has a `v0.1.0` Git tag and draft release. Preserve that tag and its artifacts.

```powershell
pnpm add -g @aectooling/revcode

# Required if lifecycle scripts were blocked; also retries pending activation:
revcode install
revcode install --revit-years 2025,2026,2027
revcode doctor
revcode rollback
revcode uninstall
pnpm remove -g @aectooling/revcode
```

Node 22.19+ is needed for package-manager and CLI bootstrap execution. The application uses bundled Node. The distribution embeds `payload.zip`, containing all production dependencies, native ZeroMQ, add-ins, host/UI, and self-contained compiler/desktop helpers. Installation never builds or downloads a secondary payload. Package-manager lifecycle policies do not affect the explicit CLI installer.

Packaging omits dependency source maps/type declarations and non-Windows-x64 ZeroMQ binaries, then tests the staged host before sealing its integrity inventory. Each distribution build also writes a build-only `size-report.json`. See [package size measurements and limits](PACKAGE-SIZE.md) for the component breakdown, tree-shaking review, and validation commands.

The immutable payload is installed in `%LOCALAPPDATA%\Revcode\packages\<version>`. Per-user manifests live in `%APPDATA%\Autodesk\Revit\Addins\<year>\Revcode.addin`. pnpm's global directory is independent of the running application.

Missing/unsupported Revit and running Revit produce successful staging with pending registration. Run `revcode install` after closing Revit or installing a supported update. Corruption, ownership conflicts, and filesystem failures exit nonzero. No process is terminated or elevated automatically.

The installer uses a Windows exclusive file handle, validates all manifest destinations, and journals the old state before activation. Each manifest is replaced atomically. An interrupted transaction restores its previous registrations on the next mutating command with Revit closed. Unexpected external manifest changes stop recovery for inspection. There is no Windows-wide atomic transaction covering multiple Revit directories; keep Revit closed throughout activation.

Active and previous versions are recorded per year. Cleanup preserves every referenced payload, pending payloads, and each year's previous release. Unknown legacy directories remain untouched. Rollback checks current Revit compatibility and user-data schema. Automatic schema changes are refused until an explicit migration is implemented.

Settings/history are preserved by removal. `pnpm remove -g @aectooling/revcode` alone does not unregister the add-in. If the global CLI is gone, run the standalone helper in a retained payload:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Revcode\packages\<version>\scripts\deployment\uninstall.ps1"
```

The helper runs a temporary copy of bundled Node so its original executable can be removed. Locked files are reported for later cleanup. Existing machine-wide or duplicate registrations require remediation by their owner.

## Maintainer setup

- Windows x64; exact Node/npm/pnpm versions and Node binary checksum in `release.config.json`, SDK in `global.json`, and checked-in NuGet lockfiles for locked native publication.
- Revit references for every target, including `RevitAPI.dll`, `RevitAPIUI.dll`, and `RevitAPI.runtimeconfig.json` from the same update.
- .NET 8 Windows Desktop runtime for transport checks; compatible licensed Revit installations for live tests.
- Git, authenticated GitHub CLI, and npm publishing rights. Package registry and GitHub repository are explicit in configuration.
- For signed releases only: Windows SDK SignTool and a signing certificate with private-key access in the current-user certificate store.

Reference overrides use these environment variables (paths can contain spaces):

```powershell
$env:REVCODE_REVIT_2025_NET8_DIR = 'C:\references\2025-net8'
$env:REVCODE_REVIT_2026_NET10_DIR = 'C:\references\2026.5'
$env:REVCODE_REVIT_2027_NET10_DIR = 'C:\references\2027'

# Only required when release.config.json has "signing": "signed":
$env:REVCODE_SIGNTOOL = 'C:\path\to\signtool.exe'
$env:REVCODE_CERT_SHA1 = '<certificate thumbprint>'
$env:REVCODE_TIMESTAMP_URL = '<publisher-approved timestamp service>'
```

Default references come from `C:\Program Files\Autodesk\Revit <year>`. Local packaging builds the available matching variants for requested years. Public releases require all configured variants.

`release.config.json` explicitly sets `"signing": "unsigned"` for the initial release, so no certificate or signing environment variables are needed. Build receipts and generated release notes record that status. To enable signing later, set `"signing": "signed"` and configure the signing variables above. Omitting the setting defaults to signed; invalid values fail. Publication requires the artifact's signing status to match the configuration. Signed releases sign and verify our `Revcode.*.dll` and `Revcode.*.exe` files before hashing/packing; third-party binaries retain their original signatures.

Confirm the public npm name before the first release. Existing names require the authenticated user to be listed as an owner. For an unclaimed name, `firstReleaseNpmUser` in `release.config.json` is set to the verified publishing account `aectooling`; preflight permits that account only while the registry reports the name absent. This cannot reserve the name against another publisher.

## Commands and immutable release sequence

Use pnpm for the documented install, build, test, and release commands. The release scripts use the pinned npm CLI internally for version metadata, packing, and publication to the npm registry. Both package managers remain covered by installation tests.

| Command | Action |
|---|---|
| `pnpm run version:patch`, `pnpm run version:minor`, `pnpm run version:major` | Bump locally; no commit/tag/push/publish |
| `pnpm run release:check` | Check branch/source, remote state, version/tag availability, tools, references, account ownership, signing configuration |
| `pnpm run release:build` | Build/test/pack committed source, signing when configured; test the actual tarball |
| `pnpm run release:patch`, `pnpm run release:minor`, `pnpm run release:major` | Preflight, one bump, version commit, and build; complete release notes before publication |
| `pnpm run release:publish` | Verify the prepared artifact and source; push/tag/publish without a bump |
| `pnpm run release:resume` | Retry unfinished publication using recorded bytes and remote integrity checks |

Version-only commands synchronize npm package and lockfile versions. pnpm lockfile v9 has no root package version, so a version-only bump leaves it unchanged. Native and distribution versions are generated from `package.json`.

Sequence: **preflight → bump → version commit/PR merge → build/optional signing/pack → exact-tarball tests → annotated tag → draft GitHub release/assets → npm publication → publish GitHub release**.

This repository explicitly sets `versionPullRequest: true`: one-command releases create a version PR and pause. This also works on private GitHub plans that do not expose the branch-rules API. After merge, check out the merged release branch and run `pnpm run release:build`. If the setting is omitted, the release command checks GitHub pull-request rules; an explicit `false` selects the direct route. A rejected protected-branch push falls back to a version PR and is never forced. Build and test again from the final merged commit before publication.

After `release:build`, complete `artifacts/releases/<version>/release-notes.md`, then run `release:publish`. No `acceptance.json` is generated, required, or uploaded. Manual test notes are optional; record them in release notes if useful. Tests run by default. When the maintainer explicitly chooses to skip them, use `pnpm run release:build --skip-tests`: this skips source/native/transport/deployment/payload tests and bundled-runtime/tarball smoke checks, records `testsSkipped` in the release receipt and artifact metadata, and prevents publication from running the skipped tarball checks. Record the omission in release notes. Source, signing-policy, and artifact-integrity checks still apply.


Build receipts, tarball, checksums, compatibility metadata, and notes stay under `artifacts/releases/<version>`. Resuming never rebuilds, bumps, moves tags, overwrites registry versions, or clobbers GitHub assets. Missing tarball-test completion can rerun that test against the saved tarball. After publication starts, asset hashes are frozen in `publication.json`; changed assets or mismatched remote integrity stop recovery. A failed build without a prepared receipt is retained under a timestamped failed directory before a retry.

## Validation and enterprise rollout

Automated installer tests cover idempotence, selective upgrades, rollback, interrupted writes/recovery, corruption, ownership conflicts, locked installation, and schema/runtime rejection. Actual tarball tests use isolated profile directories, empty package-manager caches/stores, offline mode, scripts enabled/disabled, and actual global shims for npm and pnpm. They start bundled Node/ZeroMQ and the compiler. Manual testing can cover clean-machine/browser/desktop/Revit behavior that automated tests cannot establish.

Before publication, rehearse interrupted remote steps and concurrent installations on a standard-user machine. Verify paths with spaces, missing/unsupported Revit, running Revit, multiple years, upgrades, rollback, and full removal. Run clients without developer tools. Publish the exact tested tarball; a new npm release does not update client machines automatically.

Enterprise policy must permit npm registry access through pnpm, explicit CLI or install scripts, executables under AppData, child processes launched by Revit, and provider network access. Document publisher identity, process/network behavior, proxy/corporate CA setup, third-party notices, full-trust C# execution, and model/screenshot data sent to providers. Cloud providers need user credentials; desktop automation needs an unlocked interactive session. Bundled Node, .NET runtimes, and native dependencies require ongoing security updates.
