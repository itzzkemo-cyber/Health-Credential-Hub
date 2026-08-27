# Oracle Cloud Riyadh deployment path

This directory is an **inactive future OCI reference** for Saudi Arabia Central
(Riyadh), region `me-riyadh-1`, and the production hostname
`app.wathaiqihealth.com`. The current no-cost launch uses a local Cloudflare
Tunnel and is intentionally outside these files.

Nothing here creates an Oracle account, accepts charges, changes DNS, creates a
customer secret key, or uploads production secrets. `preflight.ps1` is
read-only. The managed Terraform reference is locked by default and refuses to
plan or apply unless a separately funded production confirmation is supplied.

## Two deliberately separate profiles

### Acceptance: low cost, synthetic data only

An eligible Always Free Ampere A1 Compute VM can run the production image and a local
PostgreSQL container for short stakeholder acceptance. This is a single-node
environment with no managed database, no HA, and no production durability. It
must use only generated people/documents and must be destroyed after acceptance.
Free Tier eligibility requires the tenancy home region and A1 capacity is not
guaranteed; do not promote this profile into a permanent production system.
There is no provisioning automation for it in this directory.

### Production: paid managed services

`terraform/` describes a possible durable base: public HTTPS Load Balancer, private app
and database subnets, Container Instances release target, two-node OCI Database
with PostgreSQL, private/versioned/KMS-encrypted Object Storage, private
immutable OCIR, Vault, and least-privilege network/IAM boundaries. This profile
incurs charges and is documentation-only for now. It is never created by
preflight or GitHub Actions.

## Included

- `terraform/`: guarded paid-production reference; secret values never enter
  its variables or state. The default `FREE_ACCEPTANCE` profile deliberately
  fails before any managed resource can be planned or applied.
- `preflight.ps1`: read-only authentication, Riyadh subscription, compartment,
  Object Storage, Container Instances shape, and PostgreSQL shape checks.
- `app.env.example`: names and safe defaults only.

## Security decisions

- The production app and database have no public IP. The app subnet has an
  Oracle Services Network service-gateway route, not general internet egress.
  Email, OCR, and external automation remain fail-closed until separately
  approved.
- PostgreSQL bootstrap uses a pinned Vault secret OCID/version. Runtime secret
  values are not Terraform variables, so they do not enter Terraform state.
- Container Instances supports an environment-variable map but not Vault
  references for runtime application variables. Release operators who can read
  Container Instance configuration can read those values; restrict that
  control-plane permission tightly.
- OCI's S3 Compatibility API does **not** expose bucket CORS configuration. The
  endpoint may answer browser preflights broadly. Browser `Origin` is not an
  authorization boundary: protect uploads with short-lived scoped create-only
  presigned URLs and server-side ownership/facility authorization.
- Terraform uses `prevent_destroy` on the database, bucket, Vault, and key.

See [`docs/OCI_DEPLOYMENT.md`](../../docs/OCI_DEPLOYMENT.md) for account/IAM
requirements, production ordering, acceptance restrictions, domain cutover,
exact tests, and unresolved release gates.
