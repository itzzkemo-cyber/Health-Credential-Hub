[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$SecretsPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-LocalProductionConfig -ConfigPath $ConfigPath
$secrets = Read-LocalProductionSecrets -SecretsPath $SecretsPath
Assert-ConfigValues -Config $config
Assert-MigratorDatabaseBoundary -Config $config -Secrets $secrets

foreach ($entry in @(
    @($config.objectStorageRoot, "private object directory"),
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
Assert-VolumeAttestation -Config $config -ConfigPath $ConfigPath -SecretsPath $SecretsPath
Assert-LoopbackListener -Port ([int]$config.database.port) -Label "PostgreSQL" -RequirePresent
$dataDirectoryParameters = @{
  Config = $config
  User = $config.database.migratorUser
  Password = $secrets.MigratorDatabasePassword
  Query = "SHOW data_directory"
}
$dataDirectory = Invoke-PsqlScalar @dataDirectoryParameters
if ((Get-NormalizedPath -Path $dataDirectory) -ne (Get-NormalizedPath -Path $config.postgresDataRoot)) {
  Fail-LocalProduction "PostgreSQL data_directory does not match postgresDataRoot"
}
$apiListeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$config.port) -ErrorAction SilentlyContinue)
if ($apiListeners.Count -gt 0) {
  Fail-LocalProduction "stop the API before backup so the database and private-object snapshot remain consistent"
}
$reparsePoints = @(Get-ChildItem -LiteralPath $config.objectStorageRoot -Recurse -Force -ErrorAction Stop |
    Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
if ($reparsePoints.Count -gt 0) {
  Fail-LocalProduction "private object storage contains a reparse point"
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$suffix = [Guid]::NewGuid().ToString("N").Substring(0, 8)
$backupName = "backup-$timestamp-$suffix"
$stagingPath = Join-Path $config.backupRoot "$backupName.partial"
$finalPath = Join-Path $config.backupRoot $backupName
if ((Test-Path -LiteralPath $stagingPath) -or (Test-Path -LiteralPath $finalPath)) {
  Fail-LocalProduction "the generated backup path already exists"
}

function Remove-BackupStaging {
  if (-not (Test-Path -LiteralPath $stagingPath -PathType Container)) { return }
  $resolved = (Resolve-Path -LiteralPath $stagingPath).Path
  if (-not (Test-PathInside -ChildPath $resolved -ParentPath $config.backupRoot) -or
      -not ([IO.Path]::GetFileName($resolved)).EndsWith(".partial", [StringComparison]::Ordinal)) {
    Fail-LocalProduction "refusing to remove an unverified backup staging path"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

$null = New-Item -ItemType Directory -Path $stagingPath
Set-RestrictedAcl -Path $stagingPath -PathType Directory
$databaseDump = Join-Path $stagingPath "database.dump"
$objectsBackup = Join-Path $stagingPath "objects"
$null = New-Item -ItemType Directory -Path $objectsBackup
Set-RestrictedAcl -Path $objectsBackup -PathType Directory

try {
  $pgDump = Get-PostgresTool -Config $config -Name pg_dump
  $password = Get-SecureStringPlainText -Value $secrets.MigratorDatabasePassword
  $previousPassword = $env:PGPASSWORD
  try {
    $env:PGPASSWORD = $password
    $dumpArguments = @(
      "--host=127.0.0.1",
      "--port=$($config.database.port)",
      "--username=$($config.database.migratorUser)",
      "--dbname=$($config.database.name)",
      "--no-password",
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-acl",
      "--file=$databaseDump"
    )
    & $pgDump @dumpArguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $databaseDump -PathType Leaf)) {
      Fail-LocalProduction "pg_dump failed"
    }
  } finally {
    if ($null -eq $previousPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    else { $env:PGPASSWORD = $previousPassword }
    $password = $null
  }

  $robocopyArguments = @(
    [string]$config.objectStorageRoot,
    $objectsBackup,
    "/E", "/COPY:DAT", "/DCOPY:DAT", "/XJ", "/R:2", "/W:2", "/NP", "/NFL", "/NDL"
  )
  $null = & robocopy.exe @robocopyArguments
  $robocopyCode = $LASTEXITCODE
  if ($robocopyCode -gt 7) {
    Fail-LocalProduction "robocopy failed while copying private objects"
  }

  $objectFiles = [Collections.Generic.List[object]]::new()
  foreach ($file in (Get-ChildItem -LiteralPath $objectsBackup -File -Recurse -Force | Sort-Object FullName)) {
    $relative = [IO.Path]::GetRelativePath($objectsBackup, $file.FullName).Replace('\', '/')
    $objectFiles.Add([ordered]@{
      path = $relative
      bytes = $file.Length
      sha256 = Get-FileSha256 -Path $file.FullName
    })
  }
  $gitCommit = (& git -C (Get-RepositoryRoot) rev-parse HEAD 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $gitCommit -notmatch '^[0-9a-f]{40}$') {
    $gitCommit = "unavailable"
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    backupId = $backupName
    createdAtUtc = [DateTime]::UtcNow.ToString("o")
    sourceGitCommit = $gitCommit
    database = [ordered]@{
      name = [string]$config.database.name
      format = "postgresql-custom"
      file = "database.dump"
      bytes = (Get-Item -LiteralPath $databaseDump).Length
      sha256 = Get-FileSha256 -Path $databaseDump
    }
    objectStorage = [ordered]@{
      provider = "filesystem"
      fileCount = $objectFiles.Count
      files = $objectFiles
    }
  }
  $manifestPath = Join-Path $stagingPath "manifest.json"
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
  $manifestHash = Get-FileSha256 -Path $manifestPath
  "$manifestHash  manifest.json" | Set-Content -LiteralPath (Join-Path $stagingPath "manifest.sha256") -Encoding ascii

  $pgRestore = Get-PostgresTool -Config $config -Name pg_restore
  $null = & $pgRestore --list $databaseDump
  if ($LASTEXITCODE -ne 0) {
    Fail-LocalProduction "pg_restore could not read the new database dump"
  }
  Move-Item -LiteralPath $stagingPath -Destination $finalPath
  Assert-RestrictedAcl -Path $finalPath -Label "completed backup directory"
} catch {
  Remove-BackupStaging
  throw
}

Write-Output "Backup created at $finalPath"
Write-Output "Database dump structure, object hashes, manifest hash, ACLs, and separate encrypted local destination passed."
Write-Output "Run Test-Restore.ps1 against this backup; it must succeed before Start-Production.ps1 will run."
