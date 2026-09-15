import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Installer, ADDIN_ID } from './installer.mjs';
import { inventory, json, save } from './files.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'revcode installer test '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const system = { running: false, installs: [{ year: '2025', runtimeMajor: 8, build: '25.4.41.14' }, { year: '2026', runtimeMajor: 10, build: '26.5.0.55' }] };
  const options = { base: join(root, 'local', 'Revcode'), appData: join(root, 'roaming'), programData: join(root, 'program'), probe: () => system,
    manifestDetails: path => {
      const xml = readFileSync(path, 'utf8');
      return [{ id: /<AddInId>(.*?)<\/AddInId>/.exec(xml)?.[1] ?? '', assembly: /<Assembly>(.*?)<\/Assembly>/.exec(xml)?.[1] ?? '' }];
    } };
  const installer = new Installer(options);
  const targets = [{ id: '2025-net8', year: '2025', runtimeMajor: 8, minimumBuild: '25.0.0.0', maximumBuildExclusive: '26.0.0.0' }, { id: '2026-net10', year: '2026', runtimeMajor: 10, minimumBuild: '26.5.0.55', maximumBuildExclusive: '27.0.0.0' }];
  function payload(version, dataSchema = 1) {
    const dir = join(root, `source-${version}`);
    mkdirSync(dir);
    for (const file of ['runtime/node.exe', 'dist/host/index.js', 'compiler/Revcode.Compiler.exe', 'desktop/Revcode.Desktop.exe', ...targets.map(target => `addin/${target.id}/Revcode.Revit.dll`)]) {
      mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), version);
    }
    save(join(dir, 'package-info.json'), { version, targets, dataSchema, nodeVersion: '22.22.3' });
    save(join(dir, 'integrity.json'), inventory(dir));
    return dir;
  }
  return { root, installer, payload, system, options, targets };
}
test('install is idempotent, selective upgrade retains per-year rollback, removal preserves data', t => {
  const f = fixture(t), first = f.payload('1.0.0');
  assert.deepEqual(f.installer.install(first).registered, ['2025', '2026']);
  f.installer.install(first);
  assert.equal(f.installer.state().years['2025'].previous, null);
  f.installer.install(f.payload('1.0.1'), ['2025']);
  assert.equal(f.installer.state().years['2026'].active.version, '1.0.0');
  f.installer.rollback(['2025']);
  assert.equal(f.installer.state().years['2025'].active.version, '1.0.0');
  writeFileSync(join(f.options.base, 'history.txt'), 'keep');
  f.installer.uninstall();
  assert.equal(readFileSync(join(f.options.base, 'history.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(f.installer.payload('1.0.0')), false);
});
test('running and incompatible Revit are pending, explicit years do not bypass compatibility', t => {
  const f = fixture(t), source = f.payload('1.0.0');
  f.system.running = true;
  assert.equal(f.installer.install(source).pending.length, 2);
  assert.equal(existsSync(f.installer.destination('2025')), false);
  f.system.running = false; f.system.installs[1].build = '26.3.0.37';
  assert.equal(f.installer.install(source, ['2026']).pending.length, 1);
  assert.equal(existsSync(f.installer.destination('2026')), false);
});
test('partial activation restores all manifests and state', t => {
  const f = fixture(t); f.installer.install(f.payload('1.0.0'));
  const before = f.installer.state(), content = readFileSync(f.installer.destination('2025'), 'utf8');
  const faulty = new Installer({ ...f.options, checkpoint: () => { throw new Error('Injected power loss'); } });
  assert.throws(() => faulty.install(f.payload('1.0.1')), /Injected/);
  assert.deepEqual(f.installer.state(), before);
  assert.equal(readFileSync(f.installer.destination('2025'), 'utf8'), content);
});
test('a persisted journal recovers after an unhandled process exit', t => {
  const f = fixture(t); f.installer.install(f.payload('1.0.0'));
  const before = f.installer.state(), path = f.installer.destination('2025'), original = readFileSync(path, 'utf8');
  save(f.installer.journalPath, { before, changes: [{ year: '2025', before: original, after: 'interrupted write' }] });
  writeFileSync(path, 'interrupted write');
  f.installer.locked(() => f.installer.recover());
  assert.equal(readFileSync(path, 'utf8'), original);
});
test('foreign manifests and machine-wide duplicate IDs are never overwritten', t => {
  const f = fixture(t), source = f.payload('1.0.0'), path = f.installer.destination('2026');
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '<AddInId>foreign</AddInId>');
  assert.throws(() => f.installer.install(source), /owns/);
  assert.equal(existsSync(f.installer.destination('2025')), false);
  rmSync(path);
  const machine = join(f.options.programData, 'Autodesk/Revit/Addins/2025/Duplicate.addin');
  mkdirSync(join(machine, '..'), { recursive: true }); writeFileSync(machine, `<AddInId>${ADDIN_ID}</AddInId>`);
  assert.throws(() => f.installer.install(source), /Conflicting/);
});
test('payload tampering and different contents for the same version fail', t => {
  const f = fixture(t), source = f.payload('1.0.0'); f.installer.install(source);
  writeFileSync(join(source, 'runtime/node.exe'), 'tampered');
  assert.throws(() => f.installer.install(source), /integrity/);
  save(join(source, 'integrity.json'), inventory(source));
  assert.throws(() => f.installer.install(source), /different contents/);
});
test('rollback refuses changed runtime and automatic data schema migration', t => {
  const f = fixture(t); f.installer.install(f.payload('1.0.0')); f.installer.install(f.payload('1.0.1'));
  f.system.installs[0].runtimeMajor = 10;
  assert.throws(() => f.installer.rollback(['2025']), /incompatible/);
  assert.throws(() => f.installer.install(f.payload('2.0.0', 2)), /migration/);
});
test('active installer lock prevents another installer', t => {
  const f = fixture(t), source = f.payload('1.0.0');
  f.installer.locked(() => assert.throws(() => f.installer.install(source), /already running/));
});
test('Revit 2025 selects the matching runtime variant and refuses rollback across a runtime update', t => {
  const f = fixture(t), source = f.payload('1.0.0');
  const info = json(join(source, 'package-info.json'));
  info.targets.push({ ...f.targets[0], id: '2025-net10', runtimeMajor: 10 });
  const dll = join(source, 'addin/2025-net10/Revcode.Revit.dll');
  mkdirSync(join(dll, '..'), { recursive: true }); writeFileSync(dll, 'net10');
  save(join(source, 'package-info.json'), info); save(join(source, 'integrity.json'), inventory(source));
  f.installer.install(source, ['2025']);
  assert.equal(f.installer.state().years['2025'].active.target, '2025-net8');
  f.system.installs[0].runtimeMajor = 10;
  f.installer.install(source, ['2025']);
  assert.equal(f.installer.state().years['2025'].active.target, '2025-net10');
  assert.throws(() => f.installer.rollback(['2025']), /incompatible/);
});
test('cleanup can finish a partially deleted unreferenced payload', t => {
  const f = fixture(t); f.installer.stage(f.payload('1.0.0'));
  rmSync(join(f.installer.payload('1.0.0'), 'compiler/Revcode.Compiler.exe'));
  assert.deepEqual(f.installer.cleanup().removed, ['1.0.0']);
});
