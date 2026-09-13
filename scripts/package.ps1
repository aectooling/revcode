[CmdletBinding()]
param(
    [ValidateSet('2025', '2026', '2027')][string[]]$RevitYears = @('2026'),
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot ('artifacts\revcode-' + $packageVersion + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$packageRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $packageRoot) { throw "Output already exists: $packageRoot. Choose a fresh directory." }
foreach ($year in $RevitYears) {
    if (-not (Test-Path -LiteralPath "C:\Program Files\Autodesk\Revit $year\RevitAPI.dll")) {
        throw "Revit $year API assemblies are missing. Install that Revit version before building it."
    }
}
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}
Push-Location $repoRoot
try {
    Invoke-Checked 'npm.cmd' @('run', 'build')
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot 'dist') -Destination $packageRoot -Recurse
    foreach ($file in @('package.json', 'package-lock.json', 'LICENSE', 'README.md', 'PLAN.md', 'PROTOCOL.md', 'THIRD_PARTY_NOTICES.md')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $packageRoot
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'docs') -Destination $packageRoot -Recurse
    $scriptOutput = Join-Path $packageRoot 'scripts'
    New-Item -ItemType Directory -Path $scriptOutput -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination $scriptOutput
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination $scriptOutput

    # Dependencies are shipped beside the host, including the Windows ZeroMQ binary.
    Invoke-Checked 'npm.cmd' @('ci', '--omit=dev', '--ignore-scripts', '--prefix', $packageRoot)
    $nodePath = (& node -p 'process.execPath').Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not locate Node.' }
    $runtimeOutput = Join-Path $packageRoot 'runtime'
    New-Item -ItemType Directory -Path $runtimeOutput -Force | Out-Null
    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $runtimeOutput 'node.exe')
    $nodeLicense = Join-Path (Split-Path -Parent $nodePath) 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeLicense)) { throw "Node license missing: $nodeLicense" }
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $runtimeOutput 'NODE-LICENSE.txt')

    Invoke-Checked 'dotnet' @('publish', 'dotnet/Revcode.Compiler/Revcode.Compiler.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', (Join-Path $packageRoot 'compiler'))
    Invoke-Checked 'dotnet' @('publish', 'dotnet/Revcode.Desktop/Revcode.Desktop.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', (Join-Path $packageRoot 'desktop'))
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'desktop/Revcode.Desktop.exe'))) { throw 'Missing desktop helper.' }
    foreach ($year in $RevitYears) {
        $addinOutput = Join-Path $packageRoot "addin\$year"
        Invoke-Checked 'dotnet' @('publish', 'dotnet/Revcode.Revit/Revcode.Revit.csproj', '-c', 'Release', "-p:RevitYear=$year", '-o', $addinOutput)
        if (-not (Test-Path -LiteralPath (Join-Path $addinOutput 'Revcode.Revit.dll'))) { throw "Missing add-in for $year" }
        if (Test-Path -LiteralPath (Join-Path $addinOutput 'RevitAPI.dll')) { throw 'Packaging must not redistribute Autodesk API DLLs.' }
        if (Test-Path -LiteralPath (Join-Path $addinOutput 'RevitAPIUI.dll')) { throw 'Packaging must not redistribute Autodesk API DLLs.' }
    }
    [ordered]@{
        nodePath = 'runtime/node.exe'
        hostPath = 'dist/host/index.js'
        compilerPath = 'compiler/Revcode.Compiler.exe'
        desktopPath = 'desktop/Revcode.Desktop.exe'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'runtime.json') -Encoding UTF8
    [ordered]@{
        version = $packageVersion
        builtAt = [DateTime]::UtcNow.ToString('o')
        revitYears = @($RevitYears)
        nodeVersion = (& node --version)
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'package-info.json') -Encoding UTF8
    # Verify the shipped native binding, not just the developer installation.
    Push-Location $packageRoot
    try {
        Invoke-Checked (Join-Path $runtimeOutput 'node.exe') @('--input-type=module', '-e', "import {Router} from 'zeromq'; const r = new Router(); await r.bind('tcp://127.0.0.1:*'); r.close(); console.log('Packaged ZeroMQ OK');")
    } finally { Pop-Location }
    Write-Host "Package ready: $packageRoot"
    Write-Host "Install: powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -PackagePath `"$packageRoot`""
} finally { Pop-Location }
