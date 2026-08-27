[CmdletBinding()]
param(
  [string]$PublicUrl = "https://app.wathaiqihealth.com"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail {
  param([Parameter(Mandatory)][string]$Message)
  throw "Public verification failed: $Message"
}

function Invoke-HttpProbe {
  param(
    [Parameter(Mandatory)][string]$Uri,
    [int]$MaximumRedirection = 5,
    [ValidateSet("GET", "POST")][string]$Method = "GET",
    [string]$Body = "",
    [string]$ContentType = "application/json"
  )

  $invokeParameters = @{
    Uri = $Uri
    UseBasicParsing = $true
    TimeoutSec = 20
    MaximumRedirection = $MaximumRedirection
    Method = $Method
  }
  if ($Method -eq "POST") {
    $invokeParameters["Body"] = $Body
    $invokeParameters["ContentType"] = $ContentType
  }
  $supportsSkipHttpErrorCheck = (Get-Command Invoke-WebRequest).Parameters.ContainsKey("SkipHttpErrorCheck")
  if ($supportsSkipHttpErrorCheck) {
    $invokeParameters["SkipHttpErrorCheck"] = $true
  }

  try {
    $response = Invoke-WebRequest @invokeParameters
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Headers = $response.Headers
      Content = $response.Content
    }
  } catch {
    if ($null -eq $_.Exception.Response) {
      throw
    }
    $response = $_.Exception.Response
    if ($response -is [System.Net.Http.HttpResponseMessage]) {
      $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $headers = @{}
      foreach ($header in $response.Headers) {
        $headers[$header.Key] = (@($header.Value) -join ", ")
      }
      foreach ($header in $response.Content.Headers) {
        $headers[$header.Key] = (@($header.Value) -join ", ")
      }
      return [pscustomobject]@{
        StatusCode = [int]$response.StatusCode
        Headers = $headers
        Content = $content
      }
    }
    $reader = $null
    $content = ""
    try {
      $stream = $response.GetResponseStream()
      if ($null -ne $stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
      }
    } finally {
      if ($null -ne $reader) {
        $reader.Dispose()
      }
    }
    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Headers = $response.Headers
      Content = $content
    }
  }
}

function Get-Header {
  param(
    [Parameter(Mandatory)]$Headers,
    [Parameter(Mandatory)][string]$Name
  )
  return [string]$Headers[$Name]
}

try {
  $publicUri = [Uri]$PublicUrl
} catch {
  Fail "PublicUrl is not a valid absolute URL"
}
if ($publicUri.Scheme -ne "https" -or $publicUri.Host -ne "app.wathaiqihealth.com" -or
    $publicUri.Port -ne 443 -or $publicUri.AbsolutePath -ne "/") {
  Fail "the only approved public URL is https://app.wathaiqihealth.com"
}

$httpProbe = Invoke-HttpProbe -Uri "http://app.wathaiqihealth.com/" -MaximumRedirection 0
$location = Get-Header -Headers $httpProbe.Headers -Name "Location"
if ($httpProbe.StatusCode -notin @(301, 302, 307, 308) -or $location -notmatch '^https://app\.wathaiqihealth\.com(?:/|$)') {
  Fail "plain HTTP does not redirect to the canonical HTTPS hostname"
}

$readyProbe = Invoke-HttpProbe -Uri "$($PublicUrl.TrimEnd('/'))/api/readyz"
if ($readyProbe.StatusCode -ne 200) {
  Fail "/api/readyz did not return 200"
}
try {
  $readyBody = $readyProbe.Content | ConvertFrom-Json
} catch {
  Fail "/api/readyz did not return JSON"
}
if ($readyBody.status -ne "ready" -or $readyBody.database -ne "ok" -or
    $readyBody.objectStorage -ne "verified") {
  Fail "/api/readyz did not confirm the database and storage boundary"
}
$apiCacheControl = Get-Header -Headers $readyProbe.Headers -Name "Cache-Control"
if ($apiCacheControl -notmatch '(?i)(?:^|,)\s*no-store(?:\s*(?:,|$))') {
  Fail "API responses are not protected by Cache-Control: no-store"
}
$cloudflareCacheStatus = Get-Header -Headers $readyProbe.Headers -Name "CF-Cache-Status"
if ($cloudflareCacheStatus -match '(?i)^HIT$') {
  Fail "Cloudflare served an API response from cache"
}
$age = Get-Header -Headers $readyProbe.Headers -Name "Age"
if ($age -match '^\d+$' -and [int64]$age -gt 0) {
  Fail "an intermediary served a cached API response"
}

$loginProbe = Invoke-HttpProbe -Uri "$($PublicUrl.TrimEnd('/'))/login"
if ($loginProbe.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace($loginProbe.Content)) {
  Fail "the production sign-in page is unavailable"
}

$registrationProbe = Invoke-HttpProbe `
  -Uri "$($PublicUrl.TrimEnd('/'))/api/auth/register" `
  -Method POST `
  -Body "{}"
if ($registrationProbe.StatusCode -ne 404) {
  Fail "a public registration API path appears to be present"
}

$demoLoginProbe = Invoke-HttpProbe `
  -Uri "$($PublicUrl.TrimEnd('/'))/api/auth/demo-login" `
  -Method POST `
  -Body "{}"
if ($demoLoginProbe.StatusCode -ne 404) {
  Fail "a public Demo login API path appears to be present"
}

$hsts = Get-Header -Headers $loginProbe.Headers -Name "Strict-Transport-Security"
$csp = Get-Header -Headers $loginProbe.Headers -Name "Content-Security-Policy"
$contentTypeOptions = Get-Header -Headers $loginProbe.Headers -Name "X-Content-Type-Options"
$frameOptions = Get-Header -Headers $loginProbe.Headers -Name "X-Frame-Options"
if ($hsts -notmatch '(?i)max-age=') {
  Fail "Strict-Transport-Security is missing"
}
if ($csp -notmatch "(?i)frame-ancestors\s+'none'") {
  Fail "the Content-Security-Policy does not deny framing"
}
if ($contentTypeOptions -ne "nosniff") {
  Fail "X-Content-Type-Options is not nosniff"
}
if ($frameOptions -ne "DENY") {
  Fail "X-Frame-Options is not DENY"
}

Write-Output "Public verification passed for $PublicUrl."
Write-Output "HTTPS redirect, readiness, API cache bypass, sign-in page, disabled public registration and Demo login, and security headers passed."
Write-Output "No account, document, application data, DNS record, or service was changed."
