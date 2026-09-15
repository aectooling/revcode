[CmdletBinding()]
param(
    [ValidateSet('2025', '2026', '2027')][string[]]$RevitYears = @('2026'),
    [string]$OutputDirectory = '',
    [switch]$RequireAllTargets,
    [switch]$CheckOnly,
    [switch]$Sign
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $repoRoot 'release.config.json') -Raw | ConvertFrom-Json
$packageVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot ('artifacts\revcode-' + $packageVersion + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$packageRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $packageRoot) { throw "Output already exists: $packageRoot" }
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}
$targets = @()
foreach ($target in $config.targets) {
    if ($target.year -notin $RevitYears) { continue }
    $variable = 'REVCODE_REVIT_' + $target.id.Replace('-', '_').ToUpperInvariant() + '_DIR'
    $referenceDirectory = [Environment]::GetEnvironmentVariable($variable)
    if (-not $referenceDirectory) { $referenceDirectory = "C:\Program Files\Autodesk\Revit $($target.year)" }
    $api = Join-Path $referenceDirectory 'RevitAPI.dll'
    $runtimeConfig = Join-Path $referenceDirectory 'RevitAPI.runtimeconfig.json'
    if (-not (Test-Path -LiteralPath $api) -or -not (Test-Path -LiteralPath $runtimeConfig)) {
        if ($RequireAllTargets) { throw "Missing API/runtime references for $($target.id). Set $variable." }
        continue
    }
    $runtimeOptions = (Get-Content -LiteralPath $runtimeConfig -Raw | ConvertFrom-Json).runtimeOptions
    $tfm = [string]$runtimeOptions.tfm
    if ($tfm -notmatch '^net(\d+)\.' -or [int]$Matches[1] -ne $target.runtimeMajor) {
        if ($RequireAllTargets) { throw "Wrong runtime references for $($target.id). Set $variable to matching API references." }
        continue
    }
    $build = (Get-Item -LiteralPath $api).VersionInfo.FileVersion
    if ([version]$build -lt [version]$target.minimumBuild -or [version]$build -ge [version]$target.maximumBuildExclusive) { throw "Unsupported API build $build for $($target.id). Set $variable to supported references." }
    $targets += @{ spec=$target; directory=$referenceDirectory; build=$build; runtimeConfig=$runtimeOptions }
}
foreach ($year in $RevitYears) { if (-not ($targets | Where-Object { $_.spec.year -eq $year })) { throw "No compatible API references for Revit $year." } }
if ($CheckOnly) { $targets | ForEach-Object { Write-Host "$($_.spec.id): $($_.build) at $($_.directory)" }; return }
Push-Location $repoRoot
try {
    $nodeVersion = (& node --version).TrimStart('v').Trim()
    if ($nodeVersion -ne $config.nodeVersion) { throw "Pinned Node $($config.nodeVersion) required; found $nodeVersion." }
    $nodePath = (& node -p 'process.execPath').Trim()
    if ((Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.nodeSha256) { throw 'Node executable does not match the pinned SHA-256.' }
    Invoke-Checked 'npm.cmd' @('run', 'build')
    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot 'dist') -Destination $packageRoot -Recurse
    foreach ($file in @('package.json', 'package-lock.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $packageRoot }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'docs') -Destination $packageRoot -Recurse
    New-Item -ItemType Directory -Path (Join-Path $packageRoot 'scripts') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $packageRoot 'scripts/deployment') | Out-Null
    foreach ($file in @('cli.mjs', 'installer.mjs', 'files.mjs', 'windows.mjs', 'guard.ps1', 'uninstall.ps1', 'revcode.cjs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot "deployment/$file") -Destination (Join-Path $packageRoot 'scripts/deployment') }
    Invoke-Checked 'npm.cmd' @('ci', '--omit=dev', '--ignore-scripts', '--prefix', $packageRoot)
    $nodePath = (& node -p 'process.execPath').Trim()
    $runtimeOutput = Join-Path $packageRoot 'runtime'
    New-Item -ItemType Directory -Path $runtimeOutput | Out-Null
    Copy-Item -LiteralPath $nodePath -Destination (Join-Path $runtimeOutput 'node.exe')
    $nodeLicense = Join-Path (Split-Path -Parent $nodePath) 'LICENSE'
    if (-not (Test-Path -LiteralPath $nodeLicense)) { throw "Node license missing: $nodeLicense" }
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $runtimeOutput 'NODE-LICENSE.txt')
    foreach ($helper in @('Compiler', 'Desktop')) {
        Invoke-Checked 'dotnet' @('publish', "dotnet/Revcode.$helper/Revcode.$helper.csproj", '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:RestoreLockedMode=true', "-p:Version=$packageVersion", '-o', (Join-Path $packageRoot $helper.ToLowerInvariant()))
    }
    $matrix = @()
    foreach ($target in $targets) {
        $spec = $target.spec
        $output = Join-Path $packageRoot "addin/$($spec.id)"
        Invoke-Checked 'dotnet' @('publish', 'dotnet/Revcode.Revit/Revcode.Revit.csproj', '-c', 'Release', '-p:RestoreLockedMode=true', "-p:RevitYear=$($spec.year)", "-p:RevitRuntime=$($spec.runtimeMajor)", "-p:RevitInstallDir=$($target.directory)", "-p:Version=$packageVersion", '-o', $output)
        $matrix += [ordered]@{ id=$spec.id; year=$spec.year; runtimeMajor=$spec.runtimeMajor; minimumBuild=$target.build; maximumBuildExclusive=$spec.maximumBuildExclusive; apiBuild=$target.build; apiSha256=(Get-FileHash -LiteralPath (Join-Path $target.directory 'RevitAPI.dll') -Algorithm SHA256).Hash.ToLowerInvariant(); runtimeConfig=$target.runtimeConfig }
    }
    if (Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Where-Object { $_.Name -in @('RevitAPI.dll', 'RevitAPIUI.dll') }) { throw 'Autodesk API assemblies must not be redistributed.' }
    if ($Sign) {
        if (-not $env:REVCODE_SIGNTOOL -or -not $env:REVCODE_CERT_SHA1 -or -not $env:REVCODE_TIMESTAMP_URL) { throw 'Set REVCODE_SIGNTOOL, REVCODE_CERT_SHA1, and REVCODE_TIMESTAMP_URL for signing.' }
        foreach ($binary in (Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Where-Object { $_.Name -match '^Revcode\..*\.(dll|exe)$' })) {
            Invoke-Checked $env:REVCODE_SIGNTOOL @('sign', '/sha1', $env:REVCODE_CERT_SHA1, '/fd', 'SHA256', '/tr', $env:REVCODE_TIMESTAMP_URL, '/td', 'SHA256', $binary.FullName)
            Invoke-Checked $env:REVCODE_SIGNTOOL @('verify', '/pa', $binary.FullName)
        }
    }
    [ordered]@{ nodePath='runtime/node.exe'; hostPath='dist/host/index.js'; compilerPath='compiler/Revcode.Compiler.exe'; desktopPath='desktop/Revcode.Desktop.exe' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'runtime.json') -Encoding UTF8
    $sourceCommit = (& git rev-parse HEAD).Trim()
    [ordered]@{ version=$packageVersion; builtAt=[DateTime]::UtcNow.ToString('o'); sourceCommit=$sourceCommit; revitYears=@($RevitYears); targets=$matrix; nodeVersion=$nodeVersion; dataSchema=$config.dataSchema; signed=[bool]$Sign } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $packageRoot 'package-info.json') -Encoding UTF8
    Push-Location $packageRoot
    try { Invoke-Checked (Join-Path $runtimeOutput 'node.exe') @('--input-type=module', '-e', "import {Router} from 'zeromq'; const r = new Router(); await r.bind('tcp://127.0.0.1:*'); r.close(); console.log('Packaged ZeroMQ OK');") } finally { Pop-Location }
    Invoke-Checked 'node' @('scripts/deployment/assemble.mjs', $packageRoot, ($packageRoot + '-npm'))
    Write-Host "Package ready: $packageRoot"
} finally { Pop-Location }
