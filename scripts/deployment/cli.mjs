import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { within } from './files.mjs';
import { Installer } from './installer.mjs';
import { extract, manifestDetails, probe } from './windows.mjs';

export function main(args = process.argv.slice(2)) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Revcode requires Windows x64.');
  let command = args.shift() ?? 'help', years, source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--revit-years') {
      const value = args[++index];
      if (!value || !/^(2025|2026|2027)(,(2025|2026|2027))*$/.test(value)) throw new Error('Expected --revit-years 2025,2026,2027.');
      years = [...new Set(value.split(','))];
    } else if (args[index] === '--package-path') {
      if (!args[index + 1]) throw new Error('--package-path needs a directory.');
      source = resolve(args[++index]);
    } else throw new Error(`Unknown option: ${args[index]}`);
  }
  if (command === 'help' || command === '--help') {
    console.log('revcode install [--revit-years 2025,2026,2027]\nrevcode doctor\nrevcode rollback [--revit-years 2025,2026,2027]\nrevcode uninstall [--revit-years 2025,2026,2027]\n\nClose Revit before activation, rollback, or removal. Removing the global CLI alone leaves the add-in installed.');
    return;
  }
  for (const name of ['LOCALAPPDATA', 'APPDATA', 'ProgramData']) if (!process.env[name]) throw new Error(`Missing Windows environment variable: ${name}`);
  within(process.env.LOCALAPPDATA, join(process.env.LOCALAPPDATA, 'Revcode', 'installer.guard'));
  if (process.env.REVCODE_LOCK_PARENT !== String(process.ppid)) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('guard.ps1', import.meta.url))], {
      windowsHide: true, stdio: 'inherit', env: { ...process.env, REVCODE_GUARD_NODE: process.execPath, REVCODE_GUARD_ARGS: JSON.stringify([fileURLToPath(import.meta.url), ...process.argv.slice(2)]) },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  const installer = new Installer({ base: join(process.env.LOCALAPPDATA, 'Revcode'), appData: process.env.APPDATA, programData: process.env.ProgramData, probe, manifestDetails, extract, withLock: action => action() });
  let result;
  if (command === 'install' || command === 'postinstall') {
    if (!existsSync(join(source, 'payload.zip')) && !existsSync(join(source, 'integrity.json'))) {
      const pending = installer.state().pending;
      if (!pending) throw new Error('No prepared payload found. Build a package or run the installed revcode CLI.');
      source = installer.payload(pending.version);
      years ??= pending.years;
    }
    result = installer.install(source, years);
  } else if (command === 'rollback') result = installer.rollback(years);
  else if (command === 'uninstall') result = installer.uninstall(years);
  else if (command === 'doctor') {
    result = installer.doctor();
    if (result.problems.length) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Revcode: ${error.message}`); process.exitCode = 1; }
}
