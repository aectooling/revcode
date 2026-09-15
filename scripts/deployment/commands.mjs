import { spawnSync } from 'node:child_process';

export function run(command, args = [], { cwd = process.cwd(), env = {}, inherit = false, allowFailure = false } = {}) {
  let executable = command, argv = args;
  const environment = { ...process.env, ...env };
  if (process.platform === 'win32' && /^(npm|pnpm)$/.test(command)) {
    executable = 'powershell.exe';
    const script = `$ProgressPreference = 'SilentlyContinue'\n$a = @(ConvertFrom-Json $env:REVCODE_COMMAND_ARGS)\n$c = $env:REVCODE_COMMAND\n& $c @a\nexit $LASTEXITCODE`;
    argv = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    environment.REVCODE_COMMAND = `${command}.cmd`;
    environment.REVCODE_COMMAND_ARGS = JSON.stringify(args);
  }
  const result = spawnSync(executable, argv, { cwd, env: environment, encoding: 'utf8', windowsHide: true, stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 32 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`${command} ${args[0] ?? ''} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  return { status: result.status, stdout: result.stdout?.trimEnd() ?? '', stderr: result.stderr?.trimEnd() ?? '', error: result.error };
}
