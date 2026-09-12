[CmdletBinding()]
param(
    [string]$PackagePath = '',
    [ValidateSet('2025', '2026', '2027')][string[]]$RevitYears = @()
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$scriptRoot = Split-Path -Parent $PSScriptRoot
if (-not $PackagePath) {
    if (Test-Path -LiteralPath (Join-Path $scriptRoot 'package-info.json')) {
        $PackagePath = $scriptRoot
    } else {
        $artifactsPath = Join-Path $scriptRoot 'artifacts'
        $candidate = Get-ChildItem -LiteralPath $artifactsPath -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package-info.json') } |
            Sort-Object Name -Descending | Select-Object -First 1
        if (-not $candidate) { throw 'No package found. Run npm run package first, or pass -PackagePath.' }
        $PackagePath = $candidate.FullName
    }
}
$sourceRoot = (Resolve-Path -LiteralPath $PackagePath).Path
$info = Get-Content -LiteralPath (Join-Path $sourceRoot 'package-info.json') -Raw | ConvertFrom-Json
if ($RevitYears.Count -eq 0) { $RevitYears = @($info.revitYears) }
foreach ($year in $RevitYears) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot "addin\$year\Revcode.Revit.dll"))) { throw "Package does not contain Revit $year." }
}
if (Get-Process -Name Revit -ErrorAction SilentlyContinue) {
    throw 'Close Revit before installing Revcode. No processes have been stopped.'
}
$installBase = Join-Path $env:LOCALAPPDATA 'Revcode\packages'
$installRoot = Join-Path $installBase ($info.version + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Write-Host 'Copying the bundled runtime and dependencies...'
& robocopy.exe $sourceRoot $installRoot /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -gt 7) { throw "Package copy failed (robocopy exit $LASTEXITCODE). Manifests have not been changed." }
foreach ($year in $RevitYears) {
    $manifestDirectory = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$year"
    New-Item -ItemType Directory -Path $manifestDirectory -Force | Out-Null
    $assembly = [Security.SecurityElement]::Escape((Join-Path $installRoot "addin\$year\Revcode.Revit.dll"))
    $manifestPath = Join-Path $manifestDirectory 'Revcode.addin'
    if (Test-Path -LiteralPath $manifestPath) {
        [xml]$oldManifest = Get-Content -LiteralPath $manifestPath -Raw
        if ($oldManifest.RevitAddIns.AddIn.AddInId -ne '696A5722-BBBD-40F7-8D33-AFD7807298A6') {
            throw "A different add-in owns $manifestPath; refusing to replace it."
        }
    }
    @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>Revcode</Name>
    <Assembly>$assembly</Assembly>
    <AddInId>696A5722-BBBD-40F7-8D33-AFD7807298A6</AddInId>
    <FullClassName>Revcode.Revit.App</FullClassName>
    <VendorId>REVC</VendorId>
    <VendorDescription>Revcode local coding assistant</VendorDescription>
  </AddIn>
</RevitAddIns>
"@ | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-Host "Registered Revcode for Revit $year"
}
Write-Host "Installed: $installRoot"
Write-Host 'Open Revit, open a project, and click Add-Ins > Revcode. Revit may show its standard unsigned add-in load prompt on first use.'
