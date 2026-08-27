[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$SecretsPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Common.ps1")

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail-LocalProduction "volume attestation must run from an elevated PowerShell session"
}
$config = Read-LocalProductionConfig -ConfigPath $ConfigPath
Assert-ConfigValues -Config $config
if (-not (Test-Path -LiteralPath $SecretsPath -PathType Leaf)) {
  Fail-LocalProduction "the DPAPI secret bundle does not exist"
}
Assert-RestrictedAcl -Path $SecretsPath -Label "DPAPI secret bundle"

$paths = @(
  [string]$config.runtimeRoot,
  [string]$config.objectStorageRoot,
  [string]$config.postgresDataRoot,
  [string]$config.backupRoot,
  [string]$ConfigPath,
  [string]$SecretsPath
)
$roots = @($paths | ForEach-Object {
    [IO.Path]::GetPathRoot((Get-NormalizedPath -Path $_)).ToUpperInvariant()
  } | Sort-Object -Unique)
$volumes = @()
foreach ($root in $roots) {
  Assert-EncryptedVolume -Path $root -Label "configured volume $root"
  $driveLetter = $root.TrimEnd('\').TrimEnd(':')
  $volume = Get-Volume -DriveLetter $driveLetter -ErrorAction Stop
  if ([string]$volume.FileSystemType -ne "NTFS" -or [string]$volume.HealthStatus -ne "Healthy") {
    Fail-LocalProduction "configured volume $root must be healthy NTFS"
  }
  $volumes += [ordered]@{
    mountPoint = $root
    uniqueId = [string]$volume.UniqueId
    fileSystem = [string]$volume.FileSystemType
    fullyEncrypted = $true
    protectionOn = $true
  }
}
$attestation = [ordered]@{
  schemaVersion = 1
  verifiedAtUtc = [DateTime]::UtcNow.ToString("o")
  verifiedBySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  volumes = $volumes
}
$attestationPath = Join-Path $config.runtimeRoot "volume-attestation.json"
$attestation | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $attestationPath -Encoding utf8NoBOM
Set-RestrictedAcl -Path $attestationPath -PathType File
Write-Output "Elevated BitLocker and NTFS volume attestation passed and was recorded without secrets."
