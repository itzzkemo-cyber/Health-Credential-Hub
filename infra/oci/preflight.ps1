[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$requiredRegion = "me-riyadh-1"

function Invoke-OciJson {
  param([Parameter(Mandatory)][string[]]$Arguments)

  $raw = & oci @Arguments --output json
  if ($LASTEXITCODE -ne 0) {
    throw "OCI CLI command failed: oci $($Arguments -join ' ')"
  }
  return $raw | ConvertFrom-Json
}

if (-not (Get-Command oci -ErrorAction SilentlyContinue)) {
  throw "OCI CLI is not installed. Use Oracle's official installer before provisioning."
}
if ($env:OCI_CLI_REGION -ne $requiredRegion) {
  throw "Set OCI_CLI_REGION=me-riyadh-1 before continuing."
}
if ([string]::IsNullOrWhiteSpace($env:OCI_COMPARTMENT_ID)) {
  throw "Set OCI_COMPARTMENT_ID to the reviewed deployment compartment OCID."
}
if ($env:OCI_COMPARTMENT_ID -notmatch '^ocid1\.compartment\.oc1\.\.[A-Za-z0-9]+$') {
  throw "OCI_COMPARTMENT_ID is not a compartment OCID."
}

$subscriptions = Invoke-OciJson @("iam", "region-subscription", "list")
$riyadh = @($subscriptions.data | Where-Object {
    $_."region-name" -eq $requiredRegion -and $_.status -eq "READY"
  })
if ($riyadh.Count -ne 1) {
  throw "The tenancy is not subscribed to an active me-riyadh-1 region. Riyadh need not be the home region."
}

$compartment = Invoke-OciJson @(
  "iam", "compartment", "get", "--compartment-id", $env:OCI_COMPARTMENT_ID
)
if ($compartment.data."lifecycle-state" -ne "ACTIVE") {
  throw "The selected deployment compartment is not ACTIVE."
}

$namespace = Invoke-OciJson @("os", "ns", "get")
if ([string]::IsNullOrWhiteSpace([string]$namespace.data)) {
  throw "Object Storage namespace lookup failed."
}

$availabilityDomains = Invoke-OciJson @(
  "iam", "availability-domain", "list", "--compartment-id", $env:OCI_COMPARTMENT_ID
)
if (@($availabilityDomains.data).Count -lt 1) {
  throw "No availability domain is visible in me-riyadh-1."
}

$containerShapes = Invoke-OciJson @(
  "container-instances", "container-instance", "list-shapes",
  "--compartment-id", $env:OCI_COMPARTMENT_ID
)
$supportedContainerShape = @($containerShapes.data | Where-Object {
    $_.shape -eq "CI.Standard.E4.Flex"
  })
if ($supportedContainerShape.Count -lt 1) {
  throw "CI.Standard.E4.Flex is not available to this compartment in me-riyadh-1."
}

$postgresShapes = Invoke-OciJson @(
  "psql", "shape-summary", "list-shapes",
  "--compartment-id", $env:OCI_COMPARTMENT_ID,
  "--id", "PostgreSQL.VM.Standard.E5.Flex"
)
if (@($postgresShapes.data).Count -lt 1) {
  throw "PostgreSQL.VM.Standard.E5.Flex is not available to this compartment in me-riyadh-1."
}

Write-Output "OCI preflight passed: authenticated, compartment ACTIVE, Riyadh READY, and required managed-service shapes visible."
Write-Output "No resources were created or changed. Confirm payment, quotas, budgets, and Terraform IAM before apply."
