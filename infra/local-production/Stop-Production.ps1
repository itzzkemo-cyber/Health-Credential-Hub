[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
  [Parameter(Mandatory)][string]$ConfigPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-LocalProductionConfig -ConfigPath $ConfigPath
Assert-ConfigValues -Config $config
$pidPath = Join-Path $config.runtimeRoot "api.pid.json"
if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
  Write-Output "The production API has no PID record. Nothing was stopped."
  return
}
Assert-RestrictedAcl -Path $pidPath -Label "API PID record"
try {
  $record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
  $processId = [int]$record.processId
  $expectedNode = (Resolve-Path -LiteralPath ([string]$record.nodePath)).Path
  $expectedEntry = (Resolve-Path -LiteralPath ([string]$record.entryPoint)).Path
  $expectedRoot = (Resolve-Path -LiteralPath ([string]$record.repositoryRoot)).Path
  $startedAt = [DateTime]::Parse([string]$record.startedAtUtc).ToUniversalTime()
} catch {
  Fail-LocalProduction "the PID record is malformed; refusing to stop an unidentified process"
}
if ($expectedRoot -ne (Get-RepositoryRoot) -or
    -not (Test-PathInside -ChildPath $expectedEntry -ParentPath $expectedRoot)) {
  Fail-LocalProduction "the PID record does not describe this repository build"
}
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Remove-Item -LiteralPath $pidPath -Force
  Write-Output "Removed a stale API PID record. No live process was stopped."
  return
}
$actualStart = $process.StartTime.ToUniversalTime()
if ([Math]::Abs(($actualStart - $startedAt).TotalSeconds) -gt 2) {
  Fail-LocalProduction "the PID was reused by another process"
}
try {
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
} catch {
  Fail-LocalProduction "the process command line could not be verified"
}
if ($null -eq $cim -or
    -not ([string]$cim.ExecutablePath).Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase) -or
    -not ([string]$cim.CommandLine).Contains($expectedEntry, [StringComparison]::OrdinalIgnoreCase)) {
  Fail-LocalProduction "the PID does not belong to the reviewed API entry point"
}

if (-not $PSCmdlet.ShouldProcess("PID $processId", "Stop the verified local production API process")) {
  return
}
Stop-Process -Id $processId -Force
$null = $process.WaitForExit(15000)
if (-not $process.HasExited) {
  Fail-LocalProduction "the verified API process did not stop"
}
Remove-Item -LiteralPath $pidPath -Force
$remaining = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$config.port) -ErrorAction SilentlyContinue)
if ($remaining.Count -gt 0) {
  Fail-LocalProduction "port 3000 is still in use by another process"
}
Write-Output "The verified local production API process stopped."
