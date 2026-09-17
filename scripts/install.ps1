[CmdletBinding()]
param([switch]$ReplaceSameVersion, [string]$PackagePath = '', [ValidateSet('2025', '2026', '2027')][string[]]$RevitYears = @())
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $PackagePath) {
    $candidate = Get-ChildItem -LiteralPath (Join-Path $repoRoot 'artifacts') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'integrity.json') } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $candidate) { throw 'No prepared payload found. Run pnpm run package first or specify -PackagePath.' }
    $PackagePath = $candidate.FullName
}
$source = (Resolve-Path -LiteralPath $PackagePath).Path
$node = Join-Path $source 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Expected a prepared payload with bundled Node.' }
$arguments = @((Join-Path $source 'scripts/deployment/cli.mjs'), 'install', '--package-path', $source)
if ($ReplaceSameVersion) { $arguments += '--replace-same-version' }
if ($RevitYears.Count) { $arguments += @('--revit-years', ($RevitYears -join ',')) }
& $node @arguments
if ($LASTEXITCODE -ne 0) { throw "Installation failed ($LASTEXITCODE)." }
