[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
  [string]$ConfigPath = "C:\ProgramData\WathaiqiHealth\config.json",
  [string]$SecretsPath = "C:\ProgramData\WathaiqiHealth\secrets\production-secrets.clixml",
  [string]$RuntimeRoot = "C:\ProgramData\WathaiqiHealth\runtime",
  [string]$ObjectStorageRoot = "C:\ProgramData\WathaiqiHealth\objects",
  [string]$QuarantineRoot = "C:\ProgramData\WathaiqiHealth\quarantine",
  [string]$PostgresDataRoot = "C:\ProgramData\WathaiqiHealth\postgresql-data",
  [Parameter(Mandatory)][string]$BackupRoot,
  [Parameter(Mandatory)][string]$PostgresBin,
  [string]$NodePath = "",
  [string]$WindowsDefenderMpCmdRunPath = "",
  [ValidateRange(5000, 120000)][int]$MalwareScanTimeoutMs = 60000,
  [ValidateRange(1, 168)][int]$MaxDefenderSignatureAgeHours = 48,
  [ValidateRange(1, 65535)][int]$DatabasePort = 5432,
  [string]$DatabaseName = "wathaiqi_health",
  [string]$AppDatabaseUser = "wathaiqi_app",
  [string]$AppDatabaseRole = "wathaiqi_app_dml",
  [string]$MigratorDatabaseUser = "wathaiqi_migrator",
  [string]$MigratorDatabaseRole = "wathaiqi_migrator_ddl",
  [string]$PostgresWindowsServiceSid = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Common.ps1")

if ($env:OS -ne "Windows_NT") {
  Fail-LocalProduction "this initializer supports Windows only"
}
foreach ($identifier in @(
    @($DatabaseName, "DatabaseName"),
    @($AppDatabaseUser, "AppDatabaseUser"),
    @($AppDatabaseRole, "AppDatabaseRole"),
    @($MigratorDatabaseUser, "MigratorDatabaseUser"),
    @($MigratorDatabaseRole, "MigratorDatabaseRole")
  )) {
  Assert-SafeIdentifier -Value $identifier[0] -Label $identifier[1]
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    $NodePath = $command.Source
  } else {
    $NodePath = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  }
}

if ([string]::IsNullOrWhiteSpace($WindowsDefenderMpCmdRunPath)) {
  $platformCandidates = @()
  $platformRoot = Join-Path $env:ProgramData "Microsoft\Windows Defender\Platform"
  if (Test-Path -LiteralPath $platformRoot -PathType Container) {
    $platformCandidates = @(Get-ChildItem -LiteralPath $platformRoot -Filter MpCmdRun.exe -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -ExpandProperty FullName)
  }
  $legacyCandidate = Join-Path $env:ProgramFiles "Windows Defender\MpCmdRun.exe"
  $WindowsDefenderMpCmdRunPath = @($platformCandidates + $legacyCandidate |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
      Select-Object -First 1)
  if ($WindowsDefenderMpCmdRunPath.Count -ne 1) {
    Fail-LocalProduction "a Microsoft-signed MpCmdRun.exe could not be discovered; pass WindowsDefenderMpCmdRunPath explicitly"
  }
  $WindowsDefenderMpCmdRunPath = [string]$WindowsDefenderMpCmdRunPath[0]
}

$config = [ordered]@{
  schemaVersion = 1
  nodeEnv = "production"
  bindHost = "127.0.0.1"
  port = 3000
  publicAppUrl = "https://app.wathaiqihealth.com"
  nodePath = [System.IO.Path]::GetFullPath($NodePath)
  postgresBin = [System.IO.Path]::GetFullPath($PostgresBin)
  runtimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
  objectStorageProvider = "filesystem"
  objectStorageRoot = [System.IO.Path]::GetFullPath($ObjectStorageRoot)
  quarantineRoot = [System.IO.Path]::GetFullPath($QuarantineRoot)
  privateObjectDir = "/wathaiqi-health-private/private"
  windowsDefenderMpCmdRunPath = [System.IO.Path]::GetFullPath($WindowsDefenderMpCmdRunPath)
  malwareScanTimeoutMs = $MalwareScanTimeoutMs
  maxDefenderSignatureAgeHours = $MaxDefenderSignatureAgeHours
  postgresDataRoot = [System.IO.Path]::GetFullPath($PostgresDataRoot)
  backupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
  maxVolumeAttestationAgeDays = 7
  maxRestoreEvidenceAgeDays = 30
  database = [ordered]@{
    host = "127.0.0.1"
    port = $DatabasePort
    name = $DatabaseName
    appUser = $AppDatabaseUser
    appRole = $AppDatabaseRole
    migratorUser = $MigratorDatabaseUser
    migratorRole = $MigratorDatabaseRole
    windowsServiceSid = $PostgresWindowsServiceSid
    sslMode = "disable"
  }
}
$configObject = $config | ConvertTo-Json -Depth 5 | ConvertFrom-Json
Assert-ConfigValues -Config $configObject
$null = Assert-WindowsDefenderReady -Config $configObject
if ((Test-Path -LiteralPath $ConfigPath) -or (Test-Path -LiteralPath $SecretsPath)) {
  Fail-LocalProduction "refusing to overwrite an existing configuration or secret bundle"
}
if (-not (Test-Path -LiteralPath $config.nodePath -PathType Leaf)) {
  Fail-LocalProduction "NodePath does not exist"
}
if (-not (Test-Path -LiteralPath $config.postgresBin -PathType Container)) {
  Fail-LocalProduction "PostgresBin does not exist"
}
foreach ($tool in @("psql.exe", "pg_dump.exe", "pg_restore.exe", "createdb.exe", "dropdb.exe")) {
  if (-not (Test-Path -LiteralPath (Join-Path $config.postgresBin $tool) -PathType Leaf)) {
    Fail-LocalProduction "$tool is missing from PostgresBin"
  }
}

foreach ($entry in @(
    @($RuntimeRoot, "runtimeRoot"),
    @($ObjectStorageRoot, "objectStorageRoot"),
    @($QuarantineRoot, "quarantineRoot"),
    @($PostgresDataRoot, "postgresDataRoot"),
    @($BackupRoot, "backupRoot")
  )) {
  $volumeRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($entry[0]))
  if (-not (Test-Path -LiteralPath $volumeRoot -PathType Container)) {
    Fail-LocalProduction "$($entry[1]) volume does not exist"
  }
  Assert-EncryptedVolume -Path $entry[0] -Label $entry[1]
}

$appPassword = Read-Host "Enter a new random password for $AppDatabaseUser (24+ characters)" -AsSecureString
$migratorPassword = Read-Host "Enter a different random password for $MigratorDatabaseUser (24+ characters)" -AsSecureString
$appPlain = Get-SecureStringPlainText -Value $appPassword
$migratorPlain = Get-SecureStringPlainText -Value $migratorPassword
try {
  if ($appPlain.Length -lt 24 -or $migratorPlain.Length -lt 24) {
    Fail-LocalProduction "both PostgreSQL passwords must contain at least 24 characters"
  }
  if ($appPlain -ceq $migratorPlain) {
    Fail-LocalProduction "application and migration passwords must be different"
  }
} finally {
  $appPlain = $null
  $migratorPlain = $null
}

$sessionBytes = [byte[]]::new(48)
$totpBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($sessionBytes)
[Security.Cryptography.RandomNumberGenerator]::Fill($totpBytes)
try {
  $secretBundle = [pscustomobject]@{
    SchemaVersion = 1
    CreatedAtUtc = [DateTime]::UtcNow.ToString("o")
    WindowsIdentitySid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    AppDatabasePassword = $appPassword
    MigratorDatabasePassword = $migratorPassword
    SessionSecret = ConvertTo-SecureString ([Convert]::ToBase64String($sessionBytes)) -AsPlainText -Force
    TotpEncryptionKey = ConvertTo-SecureString ([Convert]::ToBase64String($totpBytes)) -AsPlainText -Force
  }
} finally {
  [Array]::Clear($sessionBytes, 0, $sessionBytes.Length)
  [Array]::Clear($totpBytes, 0, $totpBytes.Length)
}

$targets = @(
  $RuntimeRoot,
  $ObjectStorageRoot,
  $QuarantineRoot,
  $PostgresDataRoot,
  $BackupRoot,
  (Split-Path -Parent $ConfigPath),
  (Split-Path -Parent $SecretsPath)
) | Sort-Object -Unique

if (-not $PSCmdlet.ShouldProcess(
    ($targets -join ", "),
    "Create restricted production directories, EFS quarantine, configuration, and a user-bound DPAPI secret bundle"
  )) {
  return
}

foreach ($directory in $targets) {
  $null = New-Item -ItemType Directory -Path $directory -Force
  if ((Get-NormalizedPath -Path $directory) -eq (Get-NormalizedPath -Path $PostgresDataRoot) -and
      -not [string]::IsNullOrWhiteSpace($PostgresWindowsServiceSid)) {
    Set-RestrictedAcl -Path $directory -PathType Directory -AdditionalApprovedSids @($PostgresWindowsServiceSid)
  } else {
    Set-RestrictedAcl -Path $directory -PathType Directory
  }
}
$quarantineRemainder = @(Get-ChildItem -LiteralPath $QuarantineRoot -Force -ErrorAction Stop |
    Select-Object -First 1)
if ($quarantineRemainder.Count -gt 0) {
  Fail-LocalProduction "refusing a non-empty malware quarantine directory"
}
Enable-EfsEncryption -Path $QuarantineRoot -Label "malware quarantine directory"
Assert-EfsEncryptedDirectory -Path $QuarantineRoot -Label "malware quarantine directory"

$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ConfigPath -Encoding utf8NoBOM
$secretBundle | Export-Clixml -LiteralPath $SecretsPath
Set-RestrictedAcl -Path $ConfigPath -PathType File
Set-RestrictedAcl -Path $SecretsPath -PathType File

Write-Output "Local production directories, configuration, and DPAPI secrets were created."
& (Join-Path $PSScriptRoot "Update-VolumeAttestation.ps1") -ConfigPath $ConfigPath -SecretsPath $SecretsPath
Write-Output "No secret value was printed. Run Initialize-DatabaseRoles.ps1 next from the same Windows identity."
