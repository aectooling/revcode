[CmdletBinding()]
param([ValidateSet('2025', '2026', '2027')][string[]]$RevitYears = @('2025', '2026', '2027'))
$ErrorActionPreference = 'Stop'
if (Get-Process -Name Revit -ErrorAction SilentlyContinue) { throw 'Close Revit before uninstalling Revcode.' }
foreach ($year in $RevitYears) {
    $manifestPath = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$year\Revcode.addin"
    if (Test-Path -LiteralPath $manifestPath) {
        [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
        if ($manifest.RevitAddIns.AddIn.AddInId -ne '696A5722-BBBD-40F7-8D33-AFD7807298A6') { throw "Different add-in owns $manifestPath" }
        Remove-Item -LiteralPath $manifestPath
        Write-Host "Unregistered Revcode from Revit $year"
    }
}
Write-Host 'History, settings, and versioned package files remain in your local Revcode folder.'
