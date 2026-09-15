import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
export const json = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
export function within(root, path) {
  const base = resolve(root), full = resolve(path), rel = relative(base, full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Unsafe destination: ${full}`);
  // Refuse junctions/symlinks, including existing ancestors of the root.
  let current = full;
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Linked destination: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return full;
}
export function atomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx');
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export const save = (path, value) => atomic(path, JSON.stringify(value, null, 2) + '\n');
export function files(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Payload contains link: ${name}`);
    return entry.isDirectory() ? files(root, name) : [name];
  }).sort();
}
export function inventory(root) {
  return Object.fromEntries(files(root).filter(name => name !== 'integrity.json').map(name => [name, digest(readFileSync(join(root, name)))]));
}
export function verify(root) {
  const expected = json(join(root, 'integrity.json'));
  const actual = inventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Payload integrity mismatch: ${root}`);
  const info = json(join(root, 'package-info.json'));
  if (!/^\d+\.\d+\.\d+$/.test(info.version) || !Array.isArray(info.targets) || !Number.isInteger(info.dataSchema)) throw new Error('Invalid payload metadata.');
  for (const name of ['runtime/node.exe', 'dist/host/index.js', 'compiler/Revcode.Compiler.exe', 'desktop/Revcode.Desktop.exe', ...info.targets.map(t => `addin/${t.id}/Revcode.Revit.dll`)]) {
    if (!Object.hasOwn(expected, name)) throw new Error(`Missing payload file: ${name}`);
  }
  return info;
}
export function removeOwned(root, path) {
  const full = within(root, path);
  // Resolve immediately before a recursive operation and check the final target.
  if (existsSync(full)) { within(realpathSync(root), realpathSync(full)); rmSync(full, { recursive: true, force: true }); }
}
export function removePayload(root, path) {
  within(root, path);
  const indexPath = join(path, 'integrity.json'), expected = json(indexPath), remaining = inventory(path);
  if (!expected['package-info.json'] || !expected['runtime/node.exe']) throw new Error('Unrecognized payload inventory.');
  for (const [name, hash] of Object.entries(remaining)) if (expected[name] !== hash) throw new Error(`Changed file prevents cleanup: ${name}`);
  // Keep the inventory until the last file is removed. A locked file can leave
  // a partial deletion; the next cleanup verifies and removes the remaining subset.
  for (const name of Object.keys(remaining)) unlinkSync(within(path, join(path, name)));
  unlinkSync(indexPath);
  removeOwned(root, path);
}
