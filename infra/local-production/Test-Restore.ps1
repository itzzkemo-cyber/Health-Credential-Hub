[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$BackupPath,
  [string]$PostgresAdministrator = "postgres"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-LocalProductionConfig -ConfigPath $ConfigPath
Assert-ConfigValues -Config $config
Assert-SafeIdentifier -Value $PostgresAdministrator -Label "PostgresAdministrator"
if (-not (Test-Path -LiteralPath $BackupPath -PathType Container)) {
  Fail-LocalProduction "BackupPath does not exist"
}
$backup = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not (Test-PathInside -ChildPath $backup -ParentPath $config.backupRoot) -or
    ([IO.Path]::GetFileName($backup)).EndsWith(".partial", [StringComparison]::Ordinal)) {
  Fail-LocalProduction "BackupPath must be a completed backup under backupRoot"
}
Assert-RestrictedAcl -Path $backup -Label "backup directory"
Assert-VolumeAttestation -Config $config -ConfigPath $ConfigPath
$backupReparsePoints = @(Get-ChildItem -LiteralPath $backup -Recurse -Force -ErrorAction Stop |
    Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
if ($backupReparsePoints.Count -gt 0) {
  Fail-LocalProduction "the backup contains a reparse point"
}

$manifestPath = Join-Path $backup "manifest.json"
$manifestHashPath = Join-Path $backup "manifest.sha256"
$databaseDump = Join-Path $backup "database.dump"
$backupObjects = Join-Path $backup "objects"
foreach ($path in @($manifestPath, $manifestHashPath, $databaseDump, $backupObjects)) {
  if (-not (Test-Path -LiteralPath $path)) {
    Fail-LocalProduction "the backup is incomplete"
  }
}
try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $manifestHashRecord = (Get-Content -LiteralPath $manifestHashPath -Raw).Trim()
  if ($manifestHashRecord -notmatch '^([0-9a-fA-F]{64})  manifest\.json$') {
    throw "invalid manifest hash record"
  }
  $recordedManifestHash = $Matches[1].ToLowerInvariant()
} catch {
  Fail-LocalProduction "the backup manifest is malformed"
}
if ($manifest.schemaVersion -ne 1 -or
    $manifest.database.name -ne $config.database.name -or
    $manifest.database.format -ne "postgresql-custom" -or
    $manifest.database.file -ne "database.dump" -or
    $manifest.objectStorage.provider -ne "filesystem" -or
    $recordedManifestHash -notmatch '^[0-9a-f]{64}$' -or
    (Get-FileSha256 -Path $manifestPath) -ne $recordedManifestHash -or
    (Get-FileSha256 -Path $databaseDump) -ne [string]$manifest.database.sha256 -or
    (Get-Item -LiteralPath $databaseDump).Length -ne [long]$manifest.database.bytes) {
  Fail-LocalProduction "database dump or manifest integrity validation failed"
}

$listedFiles = @($manifest.objectStorage.files)
if ($listedFiles.Count -ne [int]$manifest.objectStorage.fileCount) {
  Fail-LocalProduction "object manifest file count is inconsistent"
}
foreach ($entry in $listedFiles) {
  $relative = ([string]$entry.path).Replace('/', '\')
  if ([IO.Path]::IsPathRooted($relative) -or $relative.Split('\') -contains '..') {
    Fail-LocalProduction "object manifest contains an unsafe relative path"
  }
  $filePath = [IO.Path]::GetFullPath((Join-Path $backupObjects $relative))
  if (-not (Test-PathInside -ChildPath $filePath -ParentPath $backupObjects) -or
      -not (Test-Path -LiteralPath $filePath -PathType Leaf) -or
      (Get-Item -LiteralPath $filePath).Length -ne [long]$entry.bytes -or
      (Get-FileSha256 -Path $filePath) -ne [string]$entry.sha256) {
    Fail-LocalProduction "private object backup integrity validation failed"
  }
}
$actualObjectCount = @(Get-ChildItem -LiteralPath $backupObjects -File -Recurse -Force).Count
if ($actualObjectCount -ne $listedFiles.Count) {
  Fail-LocalProduction "the object backup contains unmanifested files"
}

$restoreId = "wathaiqi_restore_$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))_$([Guid]::NewGuid().ToString('N').Substring(0, 6))"
Assert-SafeIdentifier -Value $restoreId -Label "disposable restore database"
$restoreWorkRoot = Join-Path $config.runtimeRoot "restore-work"
$restoreObjects = Join-Path $restoreWorkRoot $restoreId
$administratorPassword = Read-Host "Enter the PostgreSQL administrator password for the disposable restore drill" -AsSecureString

if (-not $PSCmdlet.ShouldProcess(
    "$restoreId and $restoreObjects",
    "Create, verify, and remove a disposable PostgreSQL database and private-object restore"
  )) {
  return
}

$null = New-Item -ItemType Directory -Path $restoreWorkRoot -Force
Set-RestrictedAcl -Path $restoreWorkRoot -PathType Directory
$null = New-Item -ItemType Directory -Path $restoreObjects
Set-RestrictedAcl -Path $restoreObjects -PathType Directory

$createdb = Get-PostgresTool -Config $config -Name createdb
$dropdb = Get-PostgresTool -Config $config -Name dropdb
$pgRestore = Get-PostgresTool -Config $config -Name pg_restore
$psql = Get-PostgresTool -Config $config -Name psql
$adminPlain = Get-SecureStringPlainText -Value $administratorPassword
$previousPassword = $env:PGPASSWORD
$databaseCreated = $false
$cleanupError = $null
$verified = $false
try {
  $env:PGPASSWORD = $adminPlain
  $connectionArguments = @(
    "--host=127.0.0.1",
    "--port=$($config.database.port)",
    "--username=$PostgresAdministrator",
    "--no-password"
  )
  & $createdb @connectionArguments --maintenance-db=postgres --template=template0 --encoding=UTF8 $restoreId
  if ($LASTEXITCODE -ne 0) {
    Fail-LocalProduction "the disposable restore database could not be created"
  }
  $databaseCreated = $true

  & $pgRestore @connectionArguments --dbname=$restoreId --exit-on-error --no-owner --no-acl $databaseDump
  if ($LASTEXITCODE -ne 0) {
    Fail-LocalProduction "pg_restore failed in the disposable database"
  }
  $smokeQuery = "SELECT concat_ws('|', count(*) FILTER (WHERE table_schema='public'), (to_regclass('public.users') IS NOT NULL)::int, (to_regclass('public.credentials') IS NOT NULL)::int) FROM information_schema.tables"
  $smoke = & $psql @connectionArguments --dbname=$restoreId --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=$smokeQuery 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail-LocalProduction "the restored database smoke query failed"
  }
  $smokeFields = ((@($smoke) -join "`n").Trim()).Split('|')
  if ($smokeFields.Count -ne 3 -or [int]$smokeFields[0] -lt 2 -or
      $smokeFields[1] -ne "1" -or $smokeFields[2] -ne "1") {
    Fail-LocalProduction "the restored database is missing required application tables"
  }

  $null = & robocopy.exe $backupObjects $restoreObjects /E /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:2 /NP /NFL /NDL
  if ($LASTEXITCODE -gt 7) {
    Fail-LocalProduction "the disposable private-object restore failed"
  }
  foreach ($entry in $listedFiles) {
    $restoredPath = Join-Path $restoreObjects (([string]$entry.path).Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $restoredPath -PathType Leaf) -or
        (Get-FileSha256 -Path $restoredPath) -ne [string]$entry.sha256) {
      Fail-LocalProduction "a restored private object failed checksum validation"
    }
  }
  $verified = $true
} finally {
  if ($databaseCreated) {
    try {
      & $dropdb @connectionArguments --maintenance-db=postgres --if-exists $restoreId
      if ($LASTEXITCODE -ne 0) { throw "dropdb returned a failure" }
    } catch {
      $cleanupError = "the disposable restore database could not be removed"
    }
  }
  if (Test-Path -LiteralPath $restoreObjects -PathType Container) {
    try {
      $resolvedRestore = (Resolve-Path -LiteralPath $restoreObjects).Path
      if (-not (Test-PathInside -ChildPath $resolvedRestore -ParentPath $restoreWorkRoot) -or
          [IO.Path]::GetFileName($resolvedRestore) -notmatch '^wathaiqi_restore_[a-z0-9_]+$') {
        throw "unsafe restore cleanup path"
      }
      Remove-Item -LiteralPath $resolvedRestore -Recurse -Force
    } catch {
      $cleanupError = "the disposable private-object restore could not be removed"
    }
  }
  if ($null -eq $previousPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
  else { $env:PGPASSWORD = $previousPassword }
  $adminPlain = $null
}
if ($null -ne $cleanupError) {
  Fail-LocalProduction $cleanupError
}
if (-not $verified) {
  Fail-LocalProduction "the disposable restore drill did not complete"
}

$evidence = [ordered]@{
  schemaVersion = 1
  verified = $true
  verifiedAtUtc = [DateTime]::UtcNow.ToString("o")
  manifestPath = $manifestPath
  manifestSha256 = Get-FileSha256 -Path $manifestPath
  databaseTableCount = [int]$smokeFields[0]
  objectFileCount = $listedFiles.Count
}
$evidencePath = Join-Path $config.runtimeRoot "restore-evidence.json"
$evidence | ConvertTo-Json | Set-Content -LiteralPath $evidencePath -Encoding utf8NoBOM
Set-RestrictedAcl -Path $evidencePath -PathType File

Write-Output "Disposable database and private-object restore verification passed."
Write-Output "Restore evidence was written without credentials or document contents."
