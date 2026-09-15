[CmdletBinding()]
param([ValidateSet('2025', '2026', '2027')][string[]]$RevitYears = @())
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'deployment/cli.mjs'), 'uninstall')
if ($RevitYears.Count) { $arguments += @('--revit-years', ($RevitYears -join ',')) }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Removal failed ($LASTEXITCODE)." }
