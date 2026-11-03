param([Parameter(Mandatory = $true)][ValidateSet("x64", "arm64")][string]$Architecture)
$ErrorActionPreference = "Stop"
if (-not $env:RUNNER_TEMP -or $env:CI -ne "true") { throw "Installer verification requires a CI temporary directory." }
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "release/JSON-Craft-$version-Windows-$Architecture.exe").Path
$target = Join-Path $env:RUNNER_TEMP "json-craft-install-$Architecture"

function Assert-Signature([string]$File) {
  $signature = Get-AuthenticodeSignature $File
  if ($env:REQUIRE_CODE_SIGNING -eq "true" -and $signature.Status -ne "Valid") { throw "Expected a valid publisher signature: $File ($($signature.Status))" }
  if ($signature.Status -notin @("Valid", "NotSigned")) { throw "Invalid signature: $File ($($signature.Status))" }
  Write-Output "Signature status: $($signature.Status)"
}

try {
  Assert-Signature $installer
  $installed = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$target") -Wait -PassThru
  if ($installed.ExitCode -ne 0) { throw "NSIS installer failed: $($installed.ExitCode)" }
  $executable = Join-Path $target "JSON Craft.exe"
  $bytes = [System.IO.File]::ReadAllBytes($executable)
  if ($bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw "Installed app is not a PE executable." }
  $header = [BitConverter]::ToInt32($bytes, 0x3c)
  if ([BitConverter]::ToUInt32($bytes, $header) -ne 0x4550) { throw "Invalid PE signature." }
  $expectedMachine = if ($Architecture -eq "x64") { 0x8664 } else { 0xaa64 }
  if ([BitConverter]::ToUInt16($bytes, $header + 4) -ne $expectedMachine) { throw "Installed app architecture does not match $Architecture." }
  Assert-Signature $executable
  & node scripts/packaging/smoke-packaged.mjs $executable $Architecture
  if ($LASTEXITCODE -ne 0) { throw "Installed application failed its runtime checks." }
} finally {
  $uninstaller = Join-Path $target "Uninstall JSON Craft.exe"
  if (Test-Path $uninstaller) { Start-Process -FilePath $uninstaller -ArgumentList @("/S", "_?=$target") -Wait }
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
}
