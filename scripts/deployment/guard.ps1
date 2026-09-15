$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = Join-Path $env:LOCALAPPDATA 'Revcode'
New-Item -ItemType Directory -Path $base -Force | Out-Null
$handle = $null
try {
    # Windows releases this exclusive handle if either process crashes.
    $handle = [IO.File]::Open((Join-Path $base 'installer.guard'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $env:REVCODE_LOCK_PARENT = [string]$PID
    $arguments = @(ConvertFrom-Json $env:REVCODE_GUARD_ARGS)
    & $env:REVCODE_GUARD_NODE @arguments
    exit $LASTEXITCODE
} catch {
    Write-Error "Installer could not acquire or use its exclusive lock: $_"
    exit 1
} finally {
    if ($handle) { $handle.Dispose() }
}
