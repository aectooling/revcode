import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { files, removeOwned, save } from './files.mjs';
import { prunePayload } from './prune-payload.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'revcode-prune-'));
  t.after(() => removeOwned(tmpdir(), root));
  const put = (name, content = 'fixture') => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  save(join(root, 'package.json'), { name: '@aectooling/revcode' });
  for (const name of ['package-info.json', 'runtime/node.exe', 'compiler/Revcode.Compiler.exe', 'desktop/Revcode.Desktop.exe',
    'node_modules/zeromq/build/win32/x64/node/addon.node']) put(name);
  return { root, put };
}

test('prunes only declarations, source maps and other-platform ZeroMQ binaries; repeat is a no-op', t => {
  const { root, put } = fixture(t);
  const keep = ['pkg/index.js', 'pkg/worker.mjs', 'pkg/source.ts', 'pkg/LICENSE', 'pkg/package.json',
    'pkg/catalog.json', 'pkg/image.wasm', 'pkg/runtime.map', 'pkg/oauth/provider.js',
    'zeromq/build/manifest.json', 'zeromq/lib/load-addon.js'];
  const remove = ['pkg/index.js.map', 'pkg/worker.mjs.map', 'pkg/index.cjs.map', 'pkg/index.d.ts',
    'pkg/index.d.mts', 'pkg/index.d.cts', 'pkg/index.d.ts.map',
    'zeromq/build/linux/x64/addon.node', 'zeromq/build/darwin/arm64/addon.node',
    'zeromq/build/win32/arm64/addon.node', 'zeromq/build/win32/ia32/addon.node'];
  for (const name of [...keep, ...remove]) put(`node_modules/${name}`, name);
  put('dist/host/index.js.map'); // Retain Revcode's own debugging information.
  const report = prunePayload(root);
  assert.equal(Object.values(report).reduce((n, value) => n + value.files, 0), remove.length);
  assert.equal(Object.values(report).reduce((n, value) => n + value.bytes, 0),
    remove.reduce((n, name) => n + Buffer.byteLength(name), 0));
  assert.deepEqual(files(join(root, 'node_modules')), [...keep, 'zeromq/build/win32/x64/node/addon.node'].sort());
  for (const name of keep) assert.equal(readFileSync(join(root, 'node_modules', name), 'utf8'), name);
  assert.equal(readFileSync(join(root, 'dist/host/index.js.map'), 'utf8'), 'fixture');
  assert.deepEqual(prunePayload(root), {});
});

test('refuses sealed packages without changing dependency files', t => {
  const { root, put } = fixture(t);
  put('integrity.json', '{}');
  put('node_modules/pkg/index.d.ts');
  assert.throws(() => prunePayload(root), /unsealed staged/);
  assert.equal(readFileSync(join(root, 'node_modules/pkg/index.d.ts'), 'utf8'), 'fixture');
});

test('refuses a linked dependency tree before deleting anything', t => {
  const { root, put } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'revcode-prune-outside-'));
  t.after(() => removeOwned(tmpdir(), outside));
  writeFileSync(join(outside, 'secret.d.ts'), 'keep');
  put('node_modules/pkg/index.d.ts');
  symlinkSync(outside, join(root, 'node_modules/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prunePayload(root), /link/i);
  assert.equal(readFileSync(join(outside, 'secret.d.ts'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(root, 'node_modules/pkg/index.d.ts'), 'utf8'), 'fixture');
});
