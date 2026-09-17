import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, json, within } from './files.mjs';

// This is packaging, not a dependency resolver. Keep runtime code, package
// metadata, licenses, data files, dynamic provider modules and native loaders.
function removalReason(name) {
  if (/\.(?:[cm]?js|d\.[cm]?ts)\.map$/.test(name)) return 'dependency source maps';
  if (/\.d\.[cm]?ts$/.test(name)) return 'TypeScript declarations';
  if (name.startsWith('zeromq/build/') && name.endsWith('.node') &&
      !name.startsWith('zeromq/build/win32/x64/')) return 'non-Windows-x64 ZeroMQ binaries';
}

export function prunePayload(directory) {
  const root = resolve(directory);
  // Never modify a source checkout or an installed/integrity-verified package.
  if (existsSync(join(root, 'integrity.json')) ||
      json(join(root, 'package.json')).name !== '@aectooling/revcode' ||
      !existsSync(join(root, 'package-info.json')) ||
      !existsSync(join(root, 'runtime/node.exe')) ||
      !existsSync(join(root, 'compiler/Revcode.Compiler.exe')) ||
      !existsSync(join(root, 'desktop/Revcode.Desktop.exe')))
    throw new Error('Pruning requires an unsealed staged Revcode payload.');
  const modules = within(root, join(root, 'node_modules'));
  const names = files(modules); // Refuses links before any files are removed.
  if (!names.some(name => name.startsWith('zeromq/build/win32/x64/') && name.endsWith('.node')))
    throw new Error('Windows x64 ZeroMQ binary is missing from the payload.');
  const removals = names.flatMap(name => {
    const reason = removalReason(name);
    if (!reason) return [];
    const path = within(modules, join(modules, name));
    return [{ path, reason, bytes: statSync(path).size }];
  });
  const report = {};
  for (const { path, reason, bytes } of removals) {
    unlinkSync(within(modules, path));
    const category = report[reason] ??= { files: 0, bytes: 0 };
    category.files++;
    category.bytes += bytes;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: prune-payload.mjs <unsealed-payload>');
  const report = prunePayload(process.argv[2]);
  for (const [reason, { files, bytes }] of Object.entries(report))
    console.log(`Removed ${files} ${reason}: ${(bytes / 1024 ** 2).toFixed(2)} MiB`);
}
