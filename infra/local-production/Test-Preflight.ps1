[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$SecretsPath,
  [switch]$RequireRunning
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-LocalProductionConfig -ConfigPath $ConfigPath
$secrets = Read-LocalProductionSecrets -SecretsPath $SecretsPath
Assert-ConfigValues -Config $config
$null = Get-NodeExecutable -Config $config
foreach ($tool in @("psql", "pg_dump", "pg_restore", "createdb", "dropdb")) {
  $null = Get-PostgresTool -Config $config -Name $tool
}

foreach ($entry in @(
    @($config.runtimeRoot, "runtime directory"),
    @($config.objectStorageRoot, "private object directory"),
    @($config.quarantineRoot, "malware quarantine directory"),
    @($config.postgresDataRoot, "PostgreSQL data directory"),
    @($config.backupRoot, "separate encrypted local backup directory")
  )) {
  if (-not (Test-Path -LiteralPath $entry[0] -PathType Container)) {
    Fail-LocalProduction "$($entry[1]) does not exist"
  }
  $additionalSids = if ($entry[1] -eq "PostgreSQL data directory" -and
      -not [string]::IsNullOrWhiteSpace([string]$config.database.windowsServiceSid)) {
    @([string]$config.database.windowsServiceSid)
  } else {
    @()
  }
  Assert-RestrictedAcl -Path $entry[0] -Label $entry[1] -AdditionalApprovedSids $additionalSids
}
Assert-EfsEncryptedDirectory -Path $config.quarantineRoot -Label "malware quarantine directory"
Assert-EncryptedVolume -Path $config.quarantineRoot -Label "malware quarantine directory"
$quarantineRemainder = @(Get-ChildItem -LiteralPath $config.quarantineRoot -Force -ErrorAction Stop |
    Select-Object -First 1)
if ($quarantineRemainder.Count -gt 0) {
  Fail-LocalProduction "the malware quarantine contains an abandoned file; preserve it for incident review and clear it explicitly before restart"
}
$defenderExecutable = Assert-WindowsDefenderReady -Config $config
Invoke-WindowsDefenderReadinessProbe -Config $config -ExecutablePath $defenderExecutable
Assert-VolumeAttestation -Config $config -ConfigPath $ConfigPath -SecretsPath $SecretsPath

$repositoryRoot = Get-RepositoryRoot
$requiredBuildFiles = @(
  (Join-Path $repositoryRoot "artifacts\api-server\dist\index.mjs"),
  (Join-Path $repositoryRoot "artifacts\api-server\dist\migrate.mjs"),
  (Join-Path $repositoryRoot "artifacts\health-docs\dist\public\index.html")
)
foreach ($file in $requiredBuildFiles) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    Fail-LocalProduction "a reviewed production build is missing"
  }
}

Assert-LoopbackListener -Port ([int]$config.database.port) -Label "PostgreSQL" -RequirePresent
$dataDirectoryParameters = @{
  Config = $config
  User = $config.database.appUser
  Password = $secrets.AppDatabasePassword
  Query = "SHOW data_directory"
}
$dataDirectory = Invoke-PsqlScalar @dataDirectoryParameters
if ((Get-NormalizedPath -Path $dataDirectory) -ne (Get-NormalizedPath -Path $config.postgresDataRoot)) {
  Fail-LocalProduction "PostgreSQL data_directory does not match postgresDataRoot"
}
Assert-ApplicationDatabaseBoundary -Config $config -Secrets $secrets

$probeName = ".preflight-$([Guid]::NewGuid().ToString('N'))"
$probePath = Join-Path $config.objectStorageRoot $probeName
try {
  [System.IO.File]::WriteAllText($probePath, "local-production-readiness")
  if ([System.IO.File]::ReadAllText($probePath) -ne "local-production-readiness") {
    Fail-LocalProduction "private object storage failed its read/write probe"
  }
} finally {
  if (Test-Path -LiteralPath $probePath -PathType Leaf) {
    Remove-Item -LiteralPath $probePath -Force
  }
}

$maximumAge = [int]$config.maxRestoreEvidenceAgeDays
if ($maximumAge -lt 1 -or $maximumAge -gt 90) {
  Fail-LocalProduction "maxRestoreEvidenceAgeDays must be between 1 and 90"
}
$evidencePath = Join-Path $config.runtimeRoot "restore-evidence.json"
if (-not (Test-Path -LiteralPath $evidencePath -PathType Leaf)) {
  Fail-LocalProduction "a successful disposable restore drill is required before production start"
}
Assert-RestrictedAcl -Path $evidencePath -Label "restore evidence"
try {
  $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
  $verifiedAt = [DateTime]::Parse(
    [string]$evidence.verifiedAtUtc,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
  ).ToUniversalTime()
} catch {
  Fail-LocalProduction "restore evidence is malformed"
}
if ($evidence.schemaVersion -ne 1 -or $evidence.verified -ne $true -or
    $verifiedAt -gt [DateTime]::UtcNow.AddMinutes(5) -or
    [DateTime]::UtcNow.Subtract($verifiedAt).TotalDays -gt $maximumAge) {
  Fail-LocalProduction "restore evidence is missing, expired, or unverified"
}
$manifestPath = [string]$evidence.manifestPath
if (-not (Test-PathInside -ChildPath $manifestPath -ParentPath $config.backupRoot) -or
    -not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    (Get-FileSha256 -Path $manifestPath) -ne [string]$evidence.manifestSha256) {
  Fail-LocalProduction "the backup manifest referenced by restore evidence is missing or changed"
}

$apiListeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$config.port) -ErrorAction SilentlyContinue)
if ($RequireRunning) {
  Assert-LoopbackListener -Port ([int]$config.port) -Label "production API" -RequirePresent
  try {
    $readyParameters = @{
      Uri = "http://127.0.0.1:$($config.port)/api/readyz"
      Headers = @{ Host = ([Uri]$config.publicAppUrl).Host }
      UseBasicParsing = $true
      TimeoutSec = 10
    }
    $ready = Invoke-WebRequest @readyParameters
    $body = $ready.Content | ConvertFrom-Json
  } catch {
    Fail-LocalProduction "the production readiness endpoint did not return valid JSON"
  }
  if ($ready.StatusCode -ne 200 -or $body.status -ne "ready" -or
      $body.database -ne "ok" -or $body.objectStorage -ne "verified") {
    Fail-LocalProduction "the production readiness endpoint is not ready"
  }
} elseif ($apiListeners.Count -gt 0) {
  Fail-LocalProduction "port 3000 is already active; rerun with -RequireRunning to validate the live process"
}

Write-Output "Local production preflight passed."
Write-Output "Build artifacts, DPAPI secrets, ACLs, encrypted volumes, signed Windows Defender readiness, empty EFS quarantine, loopback listeners, DML-only database role, storage probe, and restore evidence passed."
