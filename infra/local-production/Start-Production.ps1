[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$SecretsPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Common.ps1")

$preflightParameters = @{
  ConfigPath = $ConfigPath
  SecretsPath = $SecretsPath
}
$null = & (Join-Path $PSScriptRoot "Test-Preflight.ps1") @preflightParameters

$config = Read-LocalProductionConfig -ConfigPath $ConfigPath
$secrets = Read-LocalProductionSecrets -SecretsPath $SecretsPath
$repositoryRoot = Get-RepositoryRoot
$entryPoint = (Resolve-Path -LiteralPath (Join-Path $repositoryRoot "artifacts\api-server\dist\index.mjs")).Path
$node = Get-NodeExecutable -Config $config
$defenderExecutable = Assert-WindowsDefenderReady -Config $config
$runtimeRoot = (Resolve-Path -LiteralPath $config.runtimeRoot).Path
$pidPath = Join-Path $runtimeRoot "api.pid.json"
$logRoot = Join-Path $runtimeRoot "logs"
$tempRoot = Join-Path $runtimeRoot "temp"

if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  try {
    $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json).processId
    $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
  } catch {
    $existing = $null
  }
  if ($null -ne $existing) {
    Fail-LocalProduction "the production API already has a live PID record"
  }
  Remove-Item -LiteralPath $pidPath -Force
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$config.port) -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  Fail-LocalProduction "port 3000 is already in use; refusing to replace an unidentified process"
}

foreach ($directory in @($logRoot, $tempRoot)) {
  $null = New-Item -ItemType Directory -Path $directory -Force
  Set-RestrictedAcl -Path $directory -PathType Directory
}
$stdoutPath = Join-Path $logRoot "api.stdout.log"
$stderrPath = Join-Path $logRoot "api.stderr.log"
foreach ($file in @($stdoutPath, $stderrPath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    $null = New-Item -ItemType File -Path $file
  }
  Set-RestrictedAcl -Path $file -PathType File
}

$databaseUrlParameters = @{
  Config = $config
  User = $config.database.appUser
  Password = $secrets.AppDatabasePassword
}
$databaseUrl = New-DatabaseUrl @databaseUrlParameters
$sessionSecret = Get-SecureStringPlainText -Value $secrets.SessionSecret
$totpKey = Get-SecureStringPlainText -Value $secrets.TotpEncryptionKey
$environment = $null
$productionEnvironment = $null
$previousProcessEnvironment = $null
try {
  if ($sessionSecret.Length -lt 32) {
    Fail-LocalProduction "the production session secret is too short"
  }
  try {
    $totpBytes = [Convert]::FromBase64String($totpKey)
  } catch {
    Fail-LocalProduction "the TOTP encryption key is not valid Base64"
  }
  if ($totpBytes.Length -ne 32) {
    Fail-LocalProduction "the TOTP encryption key must decode to exactly 32 bytes"
  }
  [Array]::Clear($totpBytes, 0, $totpBytes.Length)

  # Start-Process -Environment requires a Hashtable. An OrderedDictionary is
  # accepted by parameter binding but is not propagated reliably to the child
  # process on Windows, which can silently drop DATABASE_URL and other required
  # production variables.
  $environment = @{}
  $safeInherited = @(
    "SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData"
  )
  foreach ($name in $safeInherited) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $environment[$name] = $value
    }
  }
  $productionEnvironment = [ordered]@{
    NODE_ENV = "production"; PORT = "3000"; BIND_HOST = "127.0.0.1"
    PUBLIC_APP_URL = [string]$config.publicAppUrl; APP_ORIGINS = [string]$config.publicAppUrl
    SESSION_COOKIE_SAME_SITE = "lax"; SESSION_SECRET = $sessionSecret
    TOTP_ENCRYPTION_KEY = $totpKey; DATABASE_URL = $databaseUrl; DB_POOL_MAX = "10"
    APP_DATABASE_USER = [string]$config.database.appUser; APP_DATABASE_ROLE = [string]$config.database.appRole
    MIGRATOR_DATABASE_USER = [string]$config.database.migratorUser; MIGRATOR_DATABASE_ROLE = [string]$config.database.migratorRole
    VERIFY_DATABASE_ROLE_BOUNDARY = "true"; OBJECT_STORAGE_PROVIDER = "filesystem"
    LOCAL_OBJECT_STORAGE_DIR = [string]$config.objectStorageRoot; PRIVATE_OBJECT_DIR = [string]$config.privateObjectDir
    MALWARE_SCAN_PROVIDER = "windows-defender"; WINDOWS_DEFENDER_MPCMDRUN_PATH = $defenderExecutable
    MALWARE_QUARANTINE_DIR = [string]$config.quarantineRoot; MALWARE_SCAN_TIMEOUT_MS = [string]$config.malwareScanTimeoutMs
    EMAIL_ALERTS_DISABLED = "1"; AUTOMATION_OUTBOX_ENABLED = "false"; AUTOMATION_WEBHOOK_ENABLED = "false"
    NODE_OPTIONS = ""; NODE_EXTRA_CA_CERTS = ""; NODE_TLS_REJECT_UNAUTHORIZED = "1"
    HTTP_PROXY = ""; HTTPS_PROXY = ""; ALL_PROXY = ""; NO_PROXY = "127.0.0.1,localhost"
    TEMP = $tempRoot; TMP = $tempRoot
  }
  foreach ($name in $productionEnvironment.Keys) {
    $environment[$name] = $productionEnvironment[$name]
  }

  # PowerShell 7.6 applies -UseNewEnvironment after -Environment on Windows,
  # silently discarding every explicit variable. Build the same minimal child
  # environment by briefly replacing this launcher process environment, start
  # the child, and restore the launcher in a finally block.
  $previousProcessEnvironment = @{}
  foreach ($entry in [Environment]::GetEnvironmentVariables("Process").GetEnumerator()) {
    $previousProcessEnvironment[[string]$entry.Key] = [string]$entry.Value
  }
  try {
    foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
      [Environment]::SetEnvironmentVariable([string]$name, $null, "Process")
    }
    foreach ($name in $environment.Keys) {
      [Environment]::SetEnvironmentVariable([string]$name, [string]$environment[$name], "Process")
    }
    $startParameters = @{
      FilePath = $node
      ArgumentList = @("--enable-source-maps", ('"{0}"' -f $entryPoint))
      WorkingDirectory = $repositoryRoot
      WindowStyle = "Hidden"
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
      PassThru = $true
    }
    $process = Start-Process @startParameters
  } finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
      [Environment]::SetEnvironmentVariable([string]$name, $null, "Process")
    }
    foreach ($name in $previousProcessEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable(
        [string]$name,
        [string]$previousProcessEnvironment[$name],
        "Process"
      )
    }
  }

  $pidRecord = [ordered]@{
    schemaVersion = 1
    processId = $process.Id
    startedAtUtc = $process.StartTime.ToUniversalTime().ToString("o")
    nodePath = $node
    entryPoint = $entryPoint
    repositoryRoot = $repositoryRoot
  }
  $pidRecord | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding utf8NoBOM
  Set-RestrictedAcl -Path $pidPath -PathType File

  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
    try {
      $readinessParameters = @{
        Uri = "http://127.0.0.1:3000/api/readyz"
        Headers = @{ Host = "app.wathaiqihealth.com" }
        UseBasicParsing = $true
        TimeoutSec = 3
      }
      $response = Invoke-WebRequest @readinessParameters
      $body = $response.Content | ConvertFrom-Json
      $ready = $response.StatusCode -eq 200 -and
        $body.status -eq "ready" -and
        $body.database -eq "ok" -and
        $body.objectStorage -eq "verified"
    } catch {
      $ready = $false
    }
    if (-not $ready) { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    Fail-LocalProduction "the API did not become production-ready within 45 seconds; inspect restricted runtime logs"
  }
} finally {
  $databaseUrl = $null
  $sessionSecret = $null
  $totpKey = $null
  $previousProcessEnvironment = $null
  if ($null -ne $environment) {
    foreach ($name in @("SESSION_SECRET", "TOTP_ENCRYPTION_KEY", "DATABASE_URL")) {
      $environment[$name] = $null
    }
  }
  if ($null -ne $productionEnvironment) {
    foreach ($name in @("SESSION_SECRET", "TOTP_ENCRYPTION_KEY", "DATABASE_URL")) {
      $productionEnvironment[$name] = $null
    }
  }
}

$runningPreflightParameters = @{
  ConfigPath = $ConfigPath
  SecretsPath = $SecretsPath
  RequireRunning = $true
}
try {
  $null = & (Join-Path $PSScriptRoot "Test-Preflight.ps1") @runningPreflightParameters
} catch {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  throw
}
Write-Output "Production API and built web application are running on loopback PID $($process.Id)."
Write-Output "The only approved public origin is https://app.wathaiqihealth.com through the named Cloudflare Tunnel."
