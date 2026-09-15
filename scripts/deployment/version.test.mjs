import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from './commands.mjs';
import { json } from './files.mjs';

test('version-only commands synchronize npm metadata without Git side effects', t => {
  const root = mkdtempSync(join(tmpdir(), 'revcode version test '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  cpSync(resolve('scripts/release.mjs'), join(root, 'scripts/release.mjs'));
  cpSync(resolve('scripts/deployment'), join(root, 'scripts/deployment'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'revcode-version-fixture', version: '0.1.0', private: true }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'revcode-version-fixture', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'revcode-version-fixture', version: '0.1.0' } } }));
  const pnpm = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
  writeFileSync(join(root, 'pnpm-lock.yaml'), pnpm);
  run('git', ['init'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture'], { cwd: root });
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout;
  for (const [kind, version] of [['patch', '0.1.1'], ['minor', '0.2.0'], ['major', '1.0.0']]) {
    run(process.execPath, ['scripts/release.mjs', 'version', kind], { cwd: root });
    assert.equal(json(join(root, 'package.json')).version, version);
    const lock = json(join(root, 'package-lock.json'));
    assert.equal(lock.version, version); assert.equal(lock.packages[''].version, version);
    assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout, head);
    assert.equal(run('git', ['tag'], { cwd: root }).stdout, '');
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), pnpm);
  }
});
