import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Exercise Node -> powershell.exe -File -> package.ps1 without building or installing Revit.
describe.skipIf(process.platform !== "win32")("build:install launcher", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revcode-build-test-"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "test" }));
    for (const file of ["build-install.mjs", "build-install.ps1"]) {
      copyFileSync(join("scripts", file), join(root, "scripts", file));
    }
    writeFileSync(join(root, "scripts", "package.ps1"), `
param([ValidateSet('2025', '2026', '2027')][string[]]$RevitYears, [string]$OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
@{ revitYears = @($RevitYears) } | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory 'package-info.json')
`);
    writeFileSync(join(root, "scripts", "install.ps1"), "throw 'Build-only must not install.'");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [join(root, "scripts", "build-install.mjs"), ...args], {
      encoding: "utf8",
      // Cold PowerShell startup can be slow on shared Windows CI runners.
      timeout: 60_000,
    });
    const diagnostics = [
      `Error: ${result.error?.stack ?? "none"}`,
      `Signal: ${result.signal ?? "none"}`,
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
    ].join("\n");
    return { ...result, diagnostics };
  }

  it.each([
    [[], ["2026"]],
    [["revit-years", "2025,2026"], ["2025", "2026"]],
    [["--revit-years", "2025,2026,2025"], ["2025", "2026"]],
  ])("passes years through both script boundaries: %j", (args, years) => {
    const result = run("build-only", ...args);
    expect(result.status, result.diagnostics).toBe(0);
    const [stage] = readdirSync(join(root, "artifacts"));
    const info = JSON.parse(readFileSync(join(root, "artifacts", stage, "package-info.json"), "utf8"));
    expect(info.revitYears).toEqual(years);
  }, 65_000);

  it.each([
    ["build-only", "revit-years"],
    ["build-only", "revit-years", "2024"],
    ["build-only", "revit-years", ",,"],
    ["build-only", "open-revit"],
  ])("rejects invalid options: %j", (...args) => {
    const result = run(...args);
    expect(result.status, result.diagnostics).toBe(1);
  }, 65_000);

  it("enables same-version replacement for local build:install", () => {
    writeFileSync(join(root, "scripts", "install.ps1"), `
param([string]$PackagePath, [switch]$ReplaceSameVersion)
if (-not $ReplaceSameVersion) { throw 'Expected automatic local replacement' }
Set-Content (Join-Path $PackagePath 'installed.txt') 'replacement enabled'
`);
    const result = run();
    expect(result.status, result.diagnostics).toBe(0);
    const [stage] = readdirSync(join(root, "artifacts"));
    expect(readFileSync(join(root, "artifacts", stage, "installed.txt"), "utf8")).toContain("replacement enabled");
  }, 65_000);

  it("propagates packaging failures", () => {
    writeFileSync(join(root, "scripts", "package.ps1"), "throw 'Packaging test failure'");
    const result = run("build-only");
    expect(result.status, result.diagnostics).toBe(1);
    expect(result.stderr).toContain("Packaging test failure");
  }, 65_000);
});
