import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest, inventory, json, save, verify } from './files.mjs';
import { powershell } from './windows.mjs';
import { measurePayload } from './measure-payload.mjs';

const [payloadArg, outputArg] = process.argv.slice(2);
if (!payloadArg || !outputArg) throw new Error('Usage: assemble.mjs <payload> <distribution-directory>');
const payload = resolve(payloadArg), output = resolve(outputArg);
if (existsSync(output)) throw new Error(`Distribution already exists: ${output}`);
save(join(payload, 'integrity.json'), inventory(payload));
const info = verify(payload);
mkdirSync(join(output, 'scripts', 'deployment'), { recursive: true });
mkdirSync(join(output, 'bin'));
for (const name of ['cli.mjs', 'installer.mjs', 'files.mjs', 'windows.mjs', 'guard.ps1']) cpSync(join(payload, 'scripts', 'deployment', name), join(output, 'scripts', 'deployment', name));
cpSync(join(payload, 'scripts', 'deployment', 'revcode.cjs'), join(output, 'bin', 'revcode.cjs'));
for (const name of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) cpSync(join(payload, name), join(output, name));
writeFileSync(join(output, 'README.md'), `# Revcode\n\n[Release notes: ${info.version}](https://github.com/aectooling/revcode/blob/main/docs/releases/${info.version}.md)\n\nA local coding assistant for Autodesk Revit on Windows x64.\n\n## Install\n\nRun \`pnpm add -g @aectooling/revcode\`, then \`revcode install\` if scripts were blocked or registration is pending. Close Revit during activation.\n\nThis release supports Revit 2025 on .NET 8 only; Revit 2026 requires 2026.5+/.NET 10; Revit 2027 uses .NET 10. The installer checks your exact build and runtime.\n\nNode 22.19+ is needed for installation and CLI management. The running application uses bundled Node and self-contained helpers; clients need no SDK or build tools.\n\n## Manage\n\n- \`revcode doctor\`: inspect compatibility, registration, and payload integrity.\n- \`revcode rollback\`: reactivate the compatible previous release with Revit closed.\n- \`revcode uninstall\`: unregister and remove owned payloads, preserving settings/history.\n- \`pnpm remove -g @aectooling/revcode\`: remove the CLI after unregistering.\n\nRemoving the global package alone does not remove the add-in. Without the CLI, run \`scripts/deployment/uninstall.ps1\` from the installed payload under \`%LOCALAPPDATA%\\Revcode\\packages\\<version>\`.\n\nCloud AI requires provider credentials and network access. C# runs with full trust inside Revit. Desktop automation requires an unlocked session. See the [deployment guide](https://github.com/aectooling/revcode/blob/main/docs/DEPLOYMENT.md) for release compatibility and enterprise requirements.\n`);
const source = json(join(payload, 'package.json'));
save(join(output, 'package.json'), {
  name: source.name, version: info.version, description: source.description, license: source.license,
  type: 'module', os: ['win32'], cpu: ['x64'], engines: { node: '>=22.19.0' },
  bin: { revcode: 'bin/revcode.cjs' }, scripts: { postinstall: 'node scripts/deployment/cli.mjs postinstall' },
  files: ['bin/', 'scripts/', 'payload.zip', 'payload-index.json', 'THIRD_PARTY_NOTICES.md'],
  repository: { type: 'git', url: 'git+https://github.com/aectooling/revcode.git' },
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
});
// Archive the complete dependency tree as an opaque payload. npm/pnpm cannot
// prune nested node_modules, rerun dependency scripts, or resolve new versions.
powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($env:REVCODE_PAYLOAD, $env:REVCODE_ARCHIVE, [IO.Compression.CompressionLevel]::Optimal, $false)`,
{ REVCODE_PAYLOAD: payload, REVCODE_ARCHIVE: join(output, 'payload.zip') });
save(join(output, 'payload-index.json'), { version: info.version, sha256: digest(readFileSync(join(output, 'payload.zip'))), targets: info.targets });
const sizes = { ...measurePayload(payload), archiveBytes: statSync(join(output, 'payload.zip')).size };
// Build evidence stays beside the distribution; it is not installed or published.
save(join(output, 'size-report.json'), sizes);
console.log(`Payload: ${(sizes.bytes / 1024 ** 2).toFixed(2)} MiB in ${sizes.files} files; archive: ${(sizes.archiveBytes / 1024 ** 2).toFixed(2)} MiB`);
console.log(`Distribution ready: ${output}`);
