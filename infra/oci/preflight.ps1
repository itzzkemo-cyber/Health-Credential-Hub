[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$requiredRegion = "me-riyadh-1"

if (-not (Get-Command oci -ErrorAction SilentlyContinue)) {
  throw "OCI CLI is not installed. Install it from Oracle's official documentation before provisioning."
}

if ($env:OCI_CLI_REGION -ne $requiredRegion) {
  throw "Set OCI_CLI_REGION=me-riyadh-1 before continuing."
}

if ([string]::IsNullOrWhiteSpace($env:OCI_COMPARTMENT_ID)) {
  throw "Set OCI_COMPARTMENT_ID to the reviewed deployment compartment."
}

$null = oci iam region-subscription list --output json | ConvertFrom-Json
$namespace = oci os ns get --output json | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($namespace.data)) {
  throw "Object Storage namespace lookup failed."
}

$subscriptions = oci iam region-subscription list --output json | ConvertFrom-Json
$riyadh = @($subscriptions.data | Where-Object { $_."region-name" -eq $requiredRegion })
if ($riyadh.Count -ne 1 -or -not $riyadh[0]."is-home-region") {
  throw "The authenticated tenancy must have an active Riyadh subscription; confirm the intended home-region decision."
}

Write-Output "OCI preflight passed: authenticated, Riyadh home region active, and Object Storage namespace available."
Write-Output "No resources were created or changed. Review charges and least-privilege IAM before provisioning."

