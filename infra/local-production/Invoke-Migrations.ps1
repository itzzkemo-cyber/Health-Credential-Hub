[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
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
$apiListeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$config.port) -ErrorAction SilentlyContinue)
if ($apiListeners.Count -gt 0) {
  Fail-LocalProduction "stop the API and Cloudflare connector before applying database migrations"
}

$repositoryRoot = Get-RepositoryRoot
$migrationEntry = Join-Path $repositoryRoot "artifacts\api-server\dist\migrate.mjs"
$migrationsRoot = Join-Path $repositoryRoot "lib\db\migrations"
if (-not (Test-Path -LiteralPath $migrationEntry -PathType Leaf) -or
    -not (Test-Path -LiteralPath $migrationsRoot -PathType Container)) {
  Fail-LocalProduction "the reviewed API build and Drizzle migrations must exist before migration"
}
$node = Get-NodeExecutable -Config $config
if (-not $PSCmdlet.ShouldProcess(
    $config.database.name,
    "Apply reviewed Drizzle migrations as the dedicated migration login"
  )) {
  return
}

$databaseUrlParameters = @{
  Config = $config
  User = $config.database.migratorUser
  Password = $secrets.MigratorDatabasePassword
}
$databaseUrl = New-DatabaseUrl @databaseUrlParameters
$variables = @{
  NODE_ENV = "production"
  DATABASE_URL = $databaseUrl
  DB_POOL_MAX = "2"
  MIGRATIONS_DIR = $migrationsRoot
  APP_DATABASE_USER = [string]$config.database.appUser
  APP_DATABASE_ROLE = [string]$config.database.appRole
  MIGRATOR_DATABASE_USER = [string]$config.database.migratorUser
  MIGRATOR_DATABASE_ROLE = [string]$config.database.migratorRole
  VERIFY_DATABASE_ROLE_BOUNDARY = "true"
}
$previous = @{}
try {
  foreach ($name in $variables.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $variables[$name], "Process")
  }
  & $node --enable-source-maps $migrationEntry
  if ($LASTEXITCODE -ne 0) {
    Fail-LocalProduction "the migration process failed"
  }
} finally {
  foreach ($name in $variables.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
  }
  $databaseUrl = $null
}

Assert-ApplicationDatabaseBoundary -Config $config -Secrets $secrets
$restoreEvidence = Join-Path $config.runtimeRoot "restore-evidence.json"
if (Test-Path -LiteralPath $restoreEvidence -PathType Leaf) {
  Remove-Item -LiteralPath $restoreEvidence -Force
}
Write-Output "Database migrations and least-privilege role verification passed."
Write-Output "Any prior restore evidence was invalidated; create and verify a fresh backup before starting production."
