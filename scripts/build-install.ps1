[CmdletBinding()]
param(
    [switch]$OpenRevit,
    [switch]$BuildOnly,
    [switch]$Help,
    [ValidateSet('2025', '2026', '2027')][string[]]$RevitYears = @('2026')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Help) {
    Write-Output @'
Build, verify, and install the local Revcode add-in for Revit on Windows x64.
Runs the production host/browser build, stages a versioned package with the
bundled Node runtime and dependencies, and registers it for your user.
Requires Node.js 22.19+, the .NET SDK, and installed Revit API assemblies.

Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-install.ps1 [options]
  -OpenRevit   Open Revit after installation.
  -BuildOnly   Build and verify the package without installing it.
  -RevitYears  Revit versions to build, e.g. -RevitYears 2025,2026. Default: 2026.
  -Help        Show this help.

Close Revit before installing. The installer replaces the registered
per-user add-in without prompting.
'@
    exit 0
}

function Invoke-Checked {
    param([string]$Command, [string[]]$CommandArgs)
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

function Assert-RevitClosed {
    if (Get-Process -Name Revit -ErrorAction SilentlyContinue) {
        throw 'Revit is running. Close Revit fully, then run this script again.'
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This installer only supports Windows.' }
    if ($BuildOnly -and $OpenRevit) { throw '-BuildOnly cannot be combined with -OpenRevit.' }
    foreach ($command in @('node', 'npm.cmd', 'dotnet')) {
        Get-Command $command -ErrorAction Stop | Out-Null
    }
    $nodeVersion = (& node --version).Trim()
    if ($nodeVersion -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { throw "Unexpected Node version: $nodeVersion." }
    if ([version]$nodeVersion.Substring(1) -lt [version]'22.19.0') {
        throw "Requires stable Node.js 22.19.0 or newer; found $nodeVersion."
    }
    foreach ($year in $RevitYears) {
        if (-not (Test-Path -LiteralPath "C:\Program Files\Autodesk\Revit $year\RevitAPI.dll")) {
            throw "Revit $year API assemblies are missing. Install that Revit version or adjust -RevitYears."
        }
    }
    if (-not $BuildOnly) { Assert-RevitClosed }

    $repoRoot = Split-Path -Parent $PSScriptRoot
    $version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
    $stage = Join-Path $repoRoot ("artifacts\revcode-$version-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))

    Write-Host "[revcode] Building and staging package at $stage"
    Invoke-Checked 'powershell.exe' @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $PSScriptRoot 'package.ps1'),
        '-RevitYears', ($RevitYears -join ','),
        '-OutputDirectory', $stage
    )
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'package-info.json'))) {
        throw 'Packaging did not produce package-info.json.'
    }

    if ($BuildOnly) {
        Write-Host "[revcode] Build and verification passed. Package files: $stage"
    } else {
        Write-Host '[revcode] Installing the staged package'
        Invoke-Checked 'powershell.exe' @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            (Join-Path $PSScriptRoot 'install.ps1'),
            '-PackagePath', $stage
        )
        Write-Host "[revcode] Installed revcode $version. Open Revit, open a project, and click Add-Ins > Revcode."
        if ($OpenRevit) {
            foreach ($year in ($RevitYears | Sort-Object -Descending)) {
                $revitExe = "C:\Program Files\Autodesk\Revit $year\Revit.exe"
                if (Test-Path -LiteralPath $revitExe) {
                    Write-Host "[revcode] Starting Revit $year"
                    Start-Process -FilePath $revitExe
                    break
                }
            }
        }
    }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
