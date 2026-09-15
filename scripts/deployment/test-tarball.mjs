import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './commands.mjs';
import { json, removeOwned, save, verify } from './files.mjs';

const tarball = resolve(process.argv[2] ?? '');
const packageName = json(fileURLToPath(new URL('../../package.json', import.meta.url))).name;
const { pnpmVersion } = json(fileURLToPath(new URL('../../release.config.json', import.meta.url)));
if (!process.argv[2] || !existsSync(tarball)) throw new Error('Usage: test-tarball.mjs <prepared.tgz>');
const scratch = mkdtempSync(join(tmpdir(), 'revcode tarball test '));
try {
  for (const manager of ['npm', 'pnpm']) for (const scriptsEnabled of [false, true]) {
    if (process.argv[3] && process.argv[3] !== `${manager}-${scriptsEnabled}`) continue;
    const dir = join(scratch, `${manager}-${scriptsEnabled}`), prefix = join(dir, 'global');
    mkdirSync(dir, { recursive: true });
    // Corepack resolves versions from cwd. Keep the isolated fixture on the
    // release toolchain instead of its unrelated default outside the repo.
    if (manager === 'pnpm') save(join(dir, 'package.json'), { private: true, packageManager: `pnpm@${pnpmVersion}` });
    const environment = {
      LOCALAPPDATA: join(dir, 'local'), APPDATA: join(dir, 'roaming'), ProgramData: join(dir, 'program'),
      npm_config_cache: join(dir, 'empty-cache'), npm_config_registry: 'http://127.0.0.1:1',
      npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
      PNPM_HOME: join(dir, 'pnpm-bin'),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    };
    mkdirSync(environment.PNPM_HOME, { recursive: true });
    environment.PATH = environment.PNPM_HOME + delimiter + process.env.PATH;
    if (manager === 'pnpm') assert.equal(run(manager, ['--version'], { cwd: dir, env: environment }).stdout, pnpmVersion, 'Tarball test requires the configured pnpm version');
    const args = manager === 'npm'
      // This isolated fixture has exactly one package and no dependencies. npm
      // 12 cannot match a name allowlist to a file tarball's registry identity.
      // Enable its lifecycle for this invocation only; no user policy is changed.
      ? ['install', '--global', '--prefix', prefix, '--offline', ...(scriptsEnabled ? ['--dangerously-allow-all-scripts'] : ['--ignore-scripts']), tarball]
      // pnpm 11 stores each global installation in prefix/v11/<hash>. Local
      // tarball approvals must match the source identity relative to that path.
      : ['add', '--global', '--global-dir', prefix, '--global-bin-dir', environment.PNPM_HOME, '--store-dir', join(dir, 'empty-store'), '--offline', ...(scriptsEnabled ? [`--allow-build=${packageName}@file:${relative(join(prefix, 'v11', 'installation'), tarball).replaceAll('\\', '/')}`] : ['--ignore-scripts']), tarball];
    run(manager, args, { cwd: dir, env: environment, inherit: true });
    if (scriptsEnabled) assert.ok(existsSync(join(environment.LOCALAPPDATA, 'Revcode', 'installation.json')), `${manager} did not execute postinstall`);
    else assert.equal(existsSync(join(environment.LOCALAPPDATA, 'Revcode', 'installation.json')), false, `${manager} ignored --ignore-scripts`);
    const cli = manager === 'npm' ? join(prefix, 'revcode.cmd') : join(environment.PNPM_HOME, 'revcode.cmd');
    assert.ok(existsSync(cli), `${manager} global CLI missing`);
    // Exercise the actual generated global shim through PowerShell.
    const invoke = command => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:REVCODE_TEST_CLI $env:REVCODE_TEST_COMMAND; exit $LASTEXITCODE'], {
      cwd: dir, env: { ...environment, REVCODE_TEST_CLI: cli, REVCODE_TEST_COMMAND: command },
    });
    invoke('install');
    const state = json(join(environment.LOCALAPPDATA, 'Revcode', 'installation.json'));
    const version = state.pending?.version ?? Object.values(state.years)[0]?.active.version;
    assert.ok(version, 'No staged version');
    const payload = join(environment.LOCALAPPDATA, 'Revcode', 'packages', version), info = verify(payload);
    run(join(payload, 'runtime', 'node.exe'), ['--input-type=module', '-e', "import {Router} from 'zeromq'; const r = new Router(); await r.bind('tcp://127.0.0.1:*'); r.close();"], { cwd: payload, env: environment });
    // No installed SDK is needed to start either self-contained helper.
    const compiler = run(join(payload, 'compiler', 'Revcode.Compiler.exe'), [], { cwd: dir, env: environment, allowFailure: true });
    assert.ok(!compiler.error && JSON.parse(compiler.stdout).diagnostics.length > 0, 'Compiler helper did not return a protocol response');
    const desktop = run(join(payload, 'desktop', 'Revcode.Desktop.exe'), [], { cwd: dir, env: environment, allowFailure: true });
    assert.ok(desktop.status === 1 && desktop.stderr.includes('Usage: Revcode.Desktop'), 'Desktop helper could not start');
    if (Object.keys(state.years).length) invoke('doctor');
    console.log(`${manager}, scripts ${scriptsEnabled ? 'enabled' : 'disabled'}: verified ${info.version}`);
    // Never touch the user's real registration; all profile roots above are isolated.
    if (!json(join(environment.LOCALAPPDATA, 'Revcode', 'installation.json')).pending) {
      if (manager === 'npm' && !scriptsEnabled) {
        run('npm', ['uninstall', '--global', '--prefix', prefix, '--ignore-scripts', packageName], { cwd: dir, env: environment });
        assert.equal(existsSync(cli), false, 'Global CLI was not removed');
        assert.ok(existsSync(payload), 'npm removal unexpectedly removed the installed payload');
        run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(payload, 'scripts', 'deployment', 'uninstall.ps1')], { cwd: dir, env: environment });
        assert.equal(existsSync(payload), false, 'Standalone uninstall left the payload behind');
      } else invoke('uninstall');
    }
  }
} finally { removeOwned(tmpdir(), scratch); }
