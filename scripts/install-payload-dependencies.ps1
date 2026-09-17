[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PackagePath)
$ErrorActionPreference = 'Stop'

# npm run exports user .npmrc settings into the environment. npm 12 treats
# inherited allow-scripts as a CLI policy and rejects it for project installs,
# even with --ignore-scripts. Keep the user's config files and other settings;
# remove only this inherited policy while installing the script-free payload.
$inheritedPolicy = [Environment]::GetEnvironmentVariable('npm_config_allow_scripts', 'Process')
try {
    [Environment]::SetEnvironmentVariable('npm_config_allow_scripts', $null, 'Process')
    & npm.cmd ci --omit=dev --ignore-scripts --prefix $PackagePath
    if ($LASTEXITCODE -ne 0) { throw "Payload dependency installation failed with exit code $LASTEXITCODE" }
} finally {
    [Environment]::SetEnvironmentVariable('npm_config_allow_scripts', $inheritedPolicy, 'Process')
}
