import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("installs payload dependencies with inherited npm policy without running scripts or changing config", () => {
  const root = mkdtempSync(join(tmpdir(), "revcode-npm-policy-"));
  try {
    const packageJson = { name: "payload-policy-fixture", version: "1.0.0", scripts: { postinstall: "node -e \"require('fs').writeFileSync('script-ran', 'unsafe')\"" } };
    writeFileSync(join(root, "package.json"), JSON.stringify(packageJson));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: packageJson.name, version: packageJson.version, lockfileVersion: 3, packages: { "": { ...packageJson, hasInstallScript: true } } }));
    const config = "allow-scripts=payload-policy-fixture\nregistry=https://registry.npmjs.org/\n";
    writeFileSync(join(root, "user.npmrc"), config);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `
$ErrorActionPreference = 'Stop'
$env:npm_config_allow_scripts = 'payload-policy-fixture'
& $env:REVCODE_INSTALL_HELPER -PackagePath $env:REVCODE_INSTALL_FIXTURE
if ($env:npm_config_allow_scripts -ne 'payload-policy-fixture') { throw 'Policy not restored after success' }
Remove-Item -LiteralPath (Join-Path $env:REVCODE_INSTALL_FIXTURE 'package-lock.json')
$failed = $false
try { & $env:REVCODE_INSTALL_HELPER -PackagePath $env:REVCODE_INSTALL_FIXTURE } catch { $failed = $true }
if (-not $failed) { throw 'Install failure was not propagated' }
if ($env:npm_config_allow_scripts -ne 'payload-policy-fixture') { throw 'Policy not restored after failure' }
exit 0
`], {
      cwd: root, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, REVCODE_INSTALL_HELPER: resolve("scripts/install-payload-dependencies.ps1"), REVCODE_INSTALL_FIXTURE: root, npm_config_userconfig: join(root, "user.npmrc"), npm_config_audit: "false", npm_config_fund: "false" },
    });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(root, "script-ran"))).toBe(false);
    expect(readFileSync(join(root, "user.npmrc"), "utf8")).toBe(config);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 65_000);
