[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$payload = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# Run from a temporary copy so the installed Node executable can be removed.
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('revcode-uninstall-' + [Guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $payload 'runtime/node.exe') -Destination (Join-Path $temporaryRoot 'node.exe')
    Copy-Item -LiteralPath $PSScriptRoot -Destination (Join-Path $temporaryRoot 'deployment') -Recurse
    & (Join-Path $temporaryRoot 'node.exe') (Join-Path $temporaryRoot 'deployment/cli.mjs') uninstall
    $result = $LASTEXITCODE
} finally {
    $resolvedTemporary = (Resolve-Path -LiteralPath $temporaryRoot).Path
    $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedTemporary.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary cleanup path.' }
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
}
exit $result
