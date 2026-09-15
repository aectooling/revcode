import { spawnSync } from 'node:child_process';
import { toNamespacedPath } from 'node:path';

export function powershell(script, values = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, ...values }, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'PowerShell failed.');
  return result.stdout.trim();
}

export function probe() {
  return JSON.parse(powershell(`
$installs = @()
foreach ($year in @('2025', '2026', '2027')) {
  $candidates = @((Join-Path $env:ProgramFiles "Autodesk\\Revit $year"))
  foreach ($key in @("HKLM:\\SOFTWARE\\Autodesk\\Revit\\$year", "HKLM:\\SOFTWARE\\Autodesk\\Revit\\Autodesk Revit $year")) {
    if (Test-Path -LiteralPath $key) {
      $keys = @((Get-Item -LiteralPath $key)) + @(Get-ChildItem -LiteralPath $key -Recurse)
      foreach ($item in $keys) {
        $props = Get-ItemProperty -LiteralPath $item.PSPath
        foreach ($name in @('InstallationLocation', 'InstallLocation', 'InstallPath')) {
          $value = $props.PSObject.Properties[$name]
          if ($value -and $value.Value) { $candidates += [string]$value.Value }
        }
      }
    }
  }
  foreach ($dir in ($candidates | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\\') } | Select-Object -Unique)) {
    $exe = Join-Path $dir 'Revit.exe'
    if (-not (Test-Path -LiteralPath $exe)) { continue }
    $build = (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
    $runtime = $null
    $config = Join-Path $dir 'RevitAPI.runtimeconfig.json'
    if (Test-Path -LiteralPath $config) {
      $options = (Get-Content -LiteralPath $config -Raw | ConvertFrom-Json).runtimeOptions
      $frameworks = @($options.framework) + @($options.frameworks) + @($options.includedFrameworks)
      $framework = $frameworks | Where-Object { $_ -and $_.name -eq 'Microsoft.NETCore.App' } | Select-Object -First 1
      if ($framework) { $runtime = [int](([string]$framework.version).Split('.')[0]) }
      elseif ($options.tfm -match '^net(\\d+)\\.') { $runtime = [int]$Matches[1] }
    }
    $installs += @{ year=$year; directory=$dir; build=$build; runtimeMajor=$runtime }
  }
}
@{ installs=@($installs); running=[bool](Get-Process -Name Revit -ErrorAction SilentlyContinue) } | ConvertTo-Json -Depth 8
`));
}

export function manifestDetails(path) {
  return JSON.parse(powershell(`
[xml]$doc = Get-Content -LiteralPath $env:REVCODE_MANIFEST -Raw
$entries = @($doc.RevitAddIns.AddIn | ForEach-Object { @{ id=[string]$_.AddInId; assembly=[string]$_.Assembly; name=[string]$_.Name } })
ConvertTo-Json -InputObject $entries
`, { REVCODE_MANIFEST: path }).replace(/^$/, '[]'));
}

export function extract(archive, destination) {
  powershell(`[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($env:REVCODE_ARCHIVE, $env:REVCODE_DESTINATION)`, { REVCODE_ARCHIVE: toNamespacedPath(archive), REVCODE_DESTINATION: toNamespacedPath(destination) });
}
