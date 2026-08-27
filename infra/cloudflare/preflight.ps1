[CmdletBinding()]
param(
  [string]$ConfigPath = "$env:USERPROFILE\.cloudflared\config.yml",
  [string]$CloudflaredPath = "",
  [string]$PublicHostname = "app.wathaiqihealth.com",
  [string]$ApexDomain = "wathaiqihealth.com",
  [string]$OriginUrl = "http://127.0.0.1:3000",
  [string]$GoogleDkimSelector = "google"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail {
  param([Parameter(Mandatory)][string]$Message)
  throw "Cloudflare preflight failed: $Message"
}

function Get-CloudflaredExecutable {
  param([string]$RequestedPath)

  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    if (-not (Test-Path -LiteralPath $RequestedPath -PathType Leaf)) {
      Fail "the supplied cloudflared executable does not exist"
    }
    return (Resolve-Path -LiteralPath $RequestedPath).Path
  }

  $command = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }

  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $wingetRoot -PathType Container) {
    $candidate = Get-ChildItem -LiteralPath $wingetRoot -Filter cloudflared.exe -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $candidate) {
      return $candidate.FullName
    }
  }

  Fail "cloudflared is not installed or is not on PATH"
}

function Test-PathInside {
  param(
    [Parameter(Mandatory)][string]$ChildPath,
    [Parameter(Mandatory)][string]$ParentPath
  )

  $child = [System.IO.Path]::GetFullPath($ChildPath).TrimEnd('\')
  $parent = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd('\')
  return $child.Equals($parent, [System.StringComparison]::OrdinalIgnoreCase) -or
    $child.StartsWith("$parent\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-RestrictedAcl {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Label
  )

  $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowedSids = @(
    $currentUserSid,
    "S-1-5-18",      # LOCAL SYSTEM
    "S-1-5-32-544"   # BUILTIN\Administrators
  )
  $readMask = [System.Security.AccessControl.FileSystemRights]::Read -bor
    [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
    [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::FullControl

  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) {
    Fail "$Label inherits ACL entries; replace them with an explicit current-user/SYSTEM/Administrators allowlist"
  }
  $currentUserCanRead = $false
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      continue
    }
    try {
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      Fail "$Label has an ACL identity that could not be validated"
    }
    if (($rule.FileSystemRights -band $readMask) -eq 0) {
      continue
    }
    if ($allowedSids -notcontains $sid) {
      Fail "$Label is readable by a principal outside the explicit allowlist ($sid)"
    }
    if ($sid -eq $currentUserSid) {
      $currentUserCanRead = $true
    }
  }
  if (-not $currentUserCanRead) {
    Fail "$Label is not readable by the current tunnel operator"
  }
}

function Get-DnsText {
  param([Parameter(Mandatory)]$Record)
  if ($null -eq $Record.Strings) {
    return ""
  }
  return (@($Record.Strings) -join "")
}

if ($env:OS -ne "Windows_NT") {
  Fail "this package supports Windows only"
}
if ($PublicHostname -ne "app.wathaiqihealth.com" -or $ApexDomain -ne "wathaiqihealth.com") {
  Fail "the release hostname and apex domain must remain app.wathaiqihealth.com and wathaiqihealth.com"
}

try {
  $origin = [Uri]$OriginUrl
} catch {
  Fail "OriginUrl is not a valid absolute URL"
}
if ($origin.Scheme -ne "http" -or $origin.Host -ne "127.0.0.1" -or $origin.Port -ne 3000 -or $origin.AbsolutePath -ne "/") {
  Fail "the only approved origin is http://127.0.0.1:3000"
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  Fail "config.yml was not found"
}
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
if (Test-PathInside -ChildPath $resolvedConfig -ParentPath $repositoryRoot) {
  Fail "config.yml must be stored outside the Git repository"
}
Assert-RestrictedAcl -Path $resolvedConfig -Label "config.yml"

$configText = Get-Content -LiteralPath $resolvedConfig -Raw
if ($configText -match '(?im)^\s*(token|token-file|credentials-contents|origincert)\s*:') {
  Fail "config.yml contains an account certificate or inline/token credential"
}
if ($configText -match '(?im)^\s*(noTLSVerify|no-tls-verify)\s*:\s*true\s*$') {
  Fail "TLS verification cannot be disabled"
}
if ($configText -match '(?im)^\s*(loglevel|transport-loglevel)\s*:\s*debug\s*$' -or
    $configText -match '(?im)^\s*trace-output\s*:') {
  Fail "debug or trace logging is not permitted for sensitive workforce traffic"
}
if ($configText -notmatch '(?im)^\s*metrics\s*:\s*127\.0\.0\.1:\d+\s*$') {
  Fail "the cloudflared metrics listener must be pinned to 127.0.0.1"
}
if ($configText -notmatch '(?im)^\s*no-autoupdate\s*:\s*true\s*$') {
  Fail "service updates must be operator-controlled with no-autoupdate enabled"
}

$tunnelMatch = [regex]::Match($configText, '(?im)^\s*tunnel\s*:\s*["'']?([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})["'']?\s*$')
if (-not $tunnelMatch.Success) {
  Fail "config.yml must contain a real named-tunnel UUID"
}
$tunnelId = $tunnelMatch.Groups[1].Value.ToLowerInvariant()
if ($tunnelId -eq "00000000-0000-4000-8000-000000000000") {
  Fail "the example tunnel UUID has not been replaced"
}

$credentialsMatch = [regex]::Match($configText, '(?im)^\s*credentials-file\s*:\s*["'']?([^\r\n"'']+)["'']?\s*$')
if (-not $credentialsMatch.Success) {
  Fail "config.yml must use a credentials-file"
}
$credentialsPath = [Environment]::ExpandEnvironmentVariables($credentialsMatch.Groups[1].Value.Trim())
if (-not [System.IO.Path]::IsPathRooted($credentialsPath)) {
  Fail "credentials-file must be an absolute path"
}
if (-not (Test-Path -LiteralPath $credentialsPath -PathType Leaf)) {
  Fail "the named-tunnel credential file does not exist"
}
$resolvedCredentials = (Resolve-Path -LiteralPath $credentialsPath).Path
if (Test-PathInside -ChildPath $resolvedCredentials -ParentPath $repositoryRoot) {
  Fail "the named-tunnel credential file must be stored outside the Git repository"
}
if ([System.IO.Path]::GetExtension($resolvedCredentials) -ne ".json" -or
    [System.IO.Path]::GetFileNameWithoutExtension($resolvedCredentials).ToLowerInvariant() -ne $tunnelId) {
  Fail "credentials-file must be the JSON file for the configured tunnel UUID"
}
Assert-RestrictedAcl -Path $resolvedCredentials -Label "the named-tunnel credential file"

$escapedHostname = [regex]::Escape($PublicHostname)
$escapedOrigin = [regex]::Escape($OriginUrl.TrimEnd('/'))
$hostnameRules = [regex]::Matches($configText, '(?im)^\s*-\s*hostname\s*:\s*([^\s#]+)\s*$')
if ($hostnameRules.Count -ne 1 -or $hostnameRules[0].Groups[1].Value -ne $PublicHostname) {
  Fail "ingress must publish only app.wathaiqihealth.com"
}
if ($configText -notmatch "(?im)^\s*service\s*:\s*$escapedOrigin\s*$") {
  Fail "the public hostname must route only to http://127.0.0.1:3000"
}
$services = [regex]::Matches($configText, '(?im)^\s*(?:-\s*)?service\s*:\s*([^\s#]+)\s*$')
if ($services.Count -ne 2 -or $services[0].Groups[1].Value -ne $OriginUrl.TrimEnd('/') -or
    $services[1].Groups[1].Value -ne "http_status:404") {
  Fail "ingress must contain exactly the approved origin followed by a 404 catch-all"
}

$cloudflared = Get-CloudflaredExecutable -RequestedPath $CloudflaredPath
$null = & $cloudflared --version 2>&1
if ($LASTEXITCODE -ne 0) {
  Fail "cloudflared could not be executed"
}
$null = & $cloudflared --config $resolvedConfig tunnel ingress validate 2>&1
if ($LASTEXITCODE -ne 0) {
  Fail "cloudflared rejected the ingress configuration"
}

if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
  Fail "Get-NetTCPConnection is unavailable, so origin exposure cannot be verified"
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $origin.Port -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
  Fail "nothing is listening on 127.0.0.1:3000"
}
$unsafeListeners = @($listeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") })
if ($unsafeListeners.Count -gt 0) {
  Fail "port 3000 is listening on a wildcard or LAN address; bind the application to loopback only"
}

try {
  $ready = Invoke-WebRequest -Uri "$($OriginUrl.TrimEnd('/'))/api/readyz" -Headers @{ Host = $PublicHostname } -UseBasicParsing -TimeoutSec 10
  $readyBody = $ready.Content | ConvertFrom-Json
} catch {
  Fail "the local production readiness endpoint did not return a valid response"
}
if ($ready.StatusCode -ne 200 -or $readyBody.status -ne "ready" -or
    $readyBody.database -ne "ok" -or $readyBody.objectStorage -ne "verified") {
  Fail "the local production readiness endpoint is not ready"
}

$nameServers = @(Resolve-DnsName -Name $ApexDomain -Type NS -DnsOnly -ErrorAction Stop |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_.NameHost) })
if ($nameServers.Count -lt 2 -or @($nameServers | Where-Object { $_.NameHost -notmatch '\.ns\.cloudflare\.com\.?$' }).Count -gt 0) {
  Fail "the authoritative nameservers are not active on Cloudflare"
}

$mxRecords = @(Resolve-DnsName -Name $ApexDomain -Type MX -DnsOnly -ErrorAction Stop)
if ($mxRecords.Count -lt 1 -or @($mxRecords | Where-Object { $_.NameExchange -match '(?i)(google|googlemail)\.com\.?$' }).Count -lt 1) {
  Fail "Google Workspace MX records are missing"
}
$apexTxt = @(Resolve-DnsName -Name $ApexDomain -Type TXT -DnsOnly -ErrorAction Stop)
$spf = @($apexTxt | ForEach-Object { Get-DnsText $_ } | Where-Object { $_ -match '(?i)^v=spf1\s+.*include:_spf\.google\.com' })
if ($spf.Count -ne 1) {
  Fail "exactly one Google Workspace SPF record is required"
}
$dkimName = "$GoogleDkimSelector._domainkey.$ApexDomain"
$dkim = @(Resolve-DnsName -Name $dkimName -Type TXT -DnsOnly -ErrorAction Stop |
    ForEach-Object { Get-DnsText $_ } | Where-Object { $_ -match '(?i)^v=DKIM1;' })
if ($dkim.Count -lt 1) {
  Fail "the Google Workspace DKIM record is missing"
}
$dmarc = @(Resolve-DnsName -Name "_dmarc.$ApexDomain" -Type TXT -DnsOnly -ErrorAction Stop |
    ForEach-Object { Get-DnsText $_ } | Where-Object { $_ -match '(?i)^v=DMARC1;' })
if ($dmarc.Count -ne 1) {
  Fail "exactly one DMARC record is required"
}

Write-Output "Cloudflare preflight passed for https://$PublicHostname."
Write-Output "Named-tunnel config, credential ACLs, loopback origin, readiness, Cloudflare nameservers, and Google Workspace DNS passed."
Write-Output "No resources, DNS records, services, application data, or credentials were changed."
