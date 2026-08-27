# Oracle Cloud Infrastructure deployment (Riyadh)

This is an **inactive future runbook** for moving **وثائقي الصحية / Wathaiqi
Health** to `me-riyadh-1` with the canonical production URL
`https://app.wathaiqihealth.com`. The current no-cost launch uses a local
Cloudflare Tunnel; it does not use or create OCI resources.

The repository only describes and validates this OCI path. It is not an
authorization to create billable resources, change DNS, or accept real employee
documents. No OCI deployment is active. Signed direct uploads also lack a
provider-ingress byte cap and malware quarantine, so funding or provisioning
alone does not clear this release gate.

## Verified service choices

Riyadh is OCI region `me-riyadh-1` (region key `RUH`) and currently has one
availability domain. The production stack uses services documented for OCI
commercial regions and then makes the tenant-specific preflight authoritative:

| Need | OCI service | Release use |
| --- | --- | --- |
| Runtime | Container Instances | Private VNIC, immutable OCIR image digest |
| Relational data | OCI Database with PostgreSQL 16 | Private endpoint, two nodes, daily backup and PITR policies |
| Documents | Object Storage | No public access, versioning, KMS bucket key |
| Secrets/keys | Vault and Key Management | HSM key; DB bootstrap and runtime JSON secrets |
| Public ingress | Flexible Load Balancer | HTTPS 443 only; backend HTTP 8080 in a private NSG |
| Image registry | OCI Registry (OCIR) | Private immutable repository |
| TLS | OCI Certificates + public CA certificate | Certificate OCID passed to the listener; no PEM in Terraform |

Primary Oracle references:

- Regions and Riyadh: <https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm>
- OCI service availability: <https://www.oracle.com/cloud/distributed-cloud/service-availability/>
- Container Instances: <https://docs.oracle.com/en-us/iaas/Content/container-instances/overview-of-container-instances.htm>
- PostgreSQL overview and private endpoints: <https://docs.oracle.com/en-us/iaas/Content/postgresql/overview.htm>
- PostgreSQL HA behavior: <https://docs.oracle.com/en-us/iaas/Content/postgresql/high-availability.htm>
- Object Storage S3 compatibility: <https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm>
- OCI Certificates with Load Balancer: <https://docs.oracle.com/en-us/iaas/Content/Balance/Tasks/managingcertificates.htm>

OCI can change quota, shape, and service availability. A documentation table is
not proof that this particular tenancy can provision a service. Run the
read-only preflight before every first plan; a missing shape is a blocker, not a
reason to silently substitute a different region or database.

## Cost profiles: do not mix them

### A. Low-cost acceptance on Compute A1

Use an eligible Always Free `VM.Standard.A1.Flex` VM only for a short stakeholder
acceptance run with generated data. Run the digest-pinned application image and
PostgreSQL 16 in separate Docker containers on that one VM. Use a separate
private **acceptance** Object Storage bucket and separate customer secret key.

This profile is intentionally limited:

- single VM, local database volume, no HA, and no managed restore SLA;
- no real employee, manager, credential, or document data;
- no production admin account and no reuse of production secrets;
- no `app.wathaiqihealth.com` cutover; use a temporary acceptance hostname with
  HTTPS or an operator-controlled tunnel;
- destroy the VM, block volume, synthetic bucket objects, credentials, and DNS
  record after the acceptance window;
- the tenancy home region must be Riyadh for an Always Free Riyadh VM;
- check eligibility in the OCI Console first. A1 capacity is not guaranteed,
  and a free trial is not a production hosting plan.

There is deliberately no automatic A1 bootstrap in this repository. An
automatic retry loop could create unexpected resources when capacity appears.
If an acceptance bootstrap is added later, it must require
`PROFILE=acceptance` and `CONFIRM=CREATE_SYNTHETIC_ACCEPTANCE`, check the shape's
free-tier eligibility returned by OCI, and refuse any production secret or
bucket.

### B. Managed production

The Terraform stack is a guarded, documentation-only production reference.
Container Instances, flexible
Load Balancer, Vault/KMS, and OCI Database with PostgreSQL are billable. Two
PostgreSQL nodes are configured because a single node is not a reviewed
production topology. Riyadh has one AD; the service can place nodes in separate
fault domains, but do **not** claim HA until a controlled failover and restore
drill passes in this tenancy.

Before any future plan, configure a budget, alert thresholds, service limits, named
owners, incident contacts, and an approved monthly estimate in OCI Cost
Management. Terraform does not approve spend.

## Account and permission prerequisites

The operator must supply externally:

1. A verified OCI pay-as-you-go tenancy subscribed to `me-riyadh-1` with a
   payment method, budget, and adequate limits for one flexible Load Balancer,
   Container Instances, Vault/KMS, Object Storage, and two PostgreSQL E5 Flex
   nodes.
2. A dedicated production compartment and a separate acceptance compartment.
3. OCI CLI authentication for a named operator. Do not commit `~/.oci/config`,
   API private keys, session tokens, customer secret keys, or auth tokens.
4. Terraform/OCI Resource Manager authority to manage the resources above plus
   tenancy-level authority to create the two narrow policies and one dynamic
   group in `terraform/vault-storage.tf`.
5. A public-CA certificate for `app.wathaiqihealth.com` imported into OCI
   Certificates in Riyadh. The private key and certificate body remain in OCI
   Certificates and never enter Terraform variables/state.
6. Control of Squarespace DNS for `wathaiqihealth.com`.

The deployment operator needs, at minimum, read compartments/availability
domains and the required `manage` permissions for virtual-network-family,
load-balancers, container-instances, repos, object-family, vaults, keys,
secret-family, postgres-db-systems/backups/work-requests, and Certificates in
the production compartment. Split day-to-day release, migration, security, and
break-glass administration after bootstrap.

## Read-only preflight

Install the current OCI CLI from Oracle, configure the intended profile, then:

```powershell
$env:OCI_CLI_REGION = "me-riyadh-1"
$env:OCI_COMPARTMENT_ID = "ocid1.compartment.oc1..REPLACE"
powershell -File infra/oci/preflight.ps1
```

It checks authentication, active compartment, Riyadh subscription state,
Object Storage namespace, an availability domain, `CI.Standard.E4.Flex`, and
`PostgreSQL.VM.Standard.E5.Flex`. It creates or changes nothing and prints no
OCIDs/secrets.

## Production Terraform: guarded future reference

Use Terraform `>=1.9,<2` with the locked OCI provider. Prefer an OCI Resource
Manager stack so production state is encrypted and access-audited. Do not keep
shared production state on a laptop and do not place secret values in `.tfvars`.

The default `deployment_profile="FREE_ACCEPTANCE"` is deliberately not
implemented by this managed stack. Its plan fails closed before any resource
can be created. Formatting and static validation remain safe:

```powershell
terraform -chdir=infra/oci/terraform init
terraform -chdir=infra/oci/terraform fmt -check
terraform -chdir=infra/oci/terraform validate
```

Do not plan or apply while the project has no funded OCI production account.
Only after separate funding, budget, IAM, and security approval may an operator
copy the example to ignored `terraform.tfvars`, set
`deployment_profile="PAID_PRODUCTION"` and
`confirm_paid_production="CREATE_PAID_PRODUCTION"`, fill the reviewed OCIDs,
and create a saved plan. That confirmation is intentionally separate from the
free-acceptance profile. It does not itself approve spend.

In a future funded and approved flow, the first apply would create the network,
Vault/KMS key, Object Storage bucket,
private OCIR repository, policies/dynamic group, Load Balancer, and TLS
listener. Database creation is off to avoid a circular dependency on a Vault
that does not yet exist.

Create a random PostgreSQL bootstrap password as a Vault **secret** in the new
Vault using the OCI Console's protected secret form. Do not put the value in a
CLI argument or shell history. Record only its secret OCID and current numeric
version in ignored `terraform.tfvars`, set `enable_database=true`, then create,
review, and apply a second plan. Terraform passes only the secret OCID/version
to OCI Database with PostgreSQL.

The stack uses `prevent_destroy` for the database, private bucket, Vault, and
KMS key. Never remove those guards to make a plan pass. Follow a separately
approved recovery/decommission procedure.

## Private Object Storage identity

The application currently uses OCI's S3-compatible signing keys, so create a
dedicated OCI IAM **user** and group for this bucket. Do not create the customer
secret key with Terraform: its value would enter Terraform state and customer
secret keys do not expire automatically.

After substituting the real group, compartment, and bucket, a tenancy
administrator should review a policy equivalent to:

```text
Allow group WathaiqiStorageApp to inspect buckets in compartment id <COMPARTMENT_OCID>
Allow group WathaiqiStorageApp to read buckets in compartment id <COMPARTMENT_OCID> where target.bucket.name='<BUCKET_NAME>'
Allow group WathaiqiStorageApp to manage objects in compartment id <COMPARTMENT_OCID> where target.bucket.name='<BUCKET_NAME>'
```

Designate the production compartment for S3 Compatibility API calls. This
changes tenancy metadata and therefore must be an explicit administrator step:

```powershell
$namespace = oci os ns get --query data --raw-output
oci os ns update-metadata --namespace $namespace `
  --default-s3-compartment-id "<COMPARTMENT_OCID>"
```

Generate one customer secret key for that dedicated user in the OCI Console.
Copy its access/secret pair once into the runtime Vault JSON described below,
then clear clipboard/history. Rotate by creating the second allowed key,
deploying it, testing, and deleting the old key.

The bucket is `NoPublicAccess`, versioned, and encrypted with an HSM-backed KMS
key and an Object Storage bucket key. Object access still requires server-side
facility/employee authorization; a bucket policy is not tenant isolation.

## Database roles and migrations

OCI PostgreSQL exposes a private endpoint only. From a controlled workload in
the app subnet:

1. Use the bootstrap administrator once to create distinct migration and
   runtime roles.
2. Apply reviewed Drizzle migrations with the migration role.
3. Configure the app `DATABASE_URL` with the restricted runtime role and
   `sslmode=verify-full`; never weaken verification for production.
4. Never give the runtime role schema-owner, role-creation, or cross-database
   privileges. Never place the bootstrap/migration URL in the runtime secret.
5. Run the guarded first-admin provisioning workflow only after migrations.
   Public account creation and Demo login are absent. Enroll MFA and change the
   one-time password immediately, with two-operator evidence.

This repository does not automatically launch a migration Container Instance.
That remains an operator step because the current Container Instances API has
no general runtime Vault-reference field and migration credentials must not be
put in Terraform state.

## Runtime Vault JSON

Create a second Vault secret whose decoded UTF-8 content is exactly this JSON:

```json
{
  "DATABASE_URL": "postgresql://healthdocs_app:REPLACE@PRIVATE_HOST:5432/healthdocs?sslmode=require",
  "SESSION_SECRET": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
  "TOTP_ENCRYPTION_KEY": "REPLACE_WITH_BASE64_OF_EXACTLY_32_RANDOM_BYTES",
  "OCI_OBJECT_STORAGE_ACCESS_KEY_ID": "REPLACE",
  "OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY": "REPLACE"
}
```

Do not include provider, endpoint, origins, feature flags, email, OCR, or
automation values. Any future release automation must reject extra/missing
keys and enforce these non-secret values:

- `NODE_ENV=production`, `PORT=8080`;
- canonical URL/origin `https://app.wathaiqihealth.com`;
- OCI Object Storage endpoint exactly in `me-riyadh-1`;
- email alerts, automation outbox, and external webhook disabled.

OCI Container Instances accepts runtime values only as environment variables;
Vault references are available for image-pull credentials, not general app
variables. Principals allowed to read Container Instance configuration can read
the environment map. Keep that permission to a small release group and audit
it. No release automation is included because a safe keyless operator identity
and funded target do not exist yet.

## Future build and release gate

No OCI release script or deployment workflow is included. A future funded
release must use the reviewed root `Dockerfile`, the exact tested `main` commit,
and a digest-pinned image in a private immutable repository. It must introduce
safe rollout, health verification, drain, and exact-resource rollback logic in
a separate reviewed change. Never release a mutable tag and never copy runtime
secret values into Terraform state, CLI arguments, or GitHub Actions secrets
without an approved keyless identity and threat model.

## TLS and Squarespace DNS cutover

Before DNS, the public-CA certificate must cover `app.wathaiqihealth.com` and
the pre-DNS `curl --resolve` readiness test must pass. Then in Squarespace DNS:

1. Add an `A` record with host `app`, value equal to Terraform output
   `load_balancer_ip`, and a short migration TTL such as 300 seconds.
2. Do not change root-domain, Google Workspace MX, SPF, DKIM, or DMARC records.
3. Wait for public resolution and verify from two independent networks:

```powershell
Resolve-DnsName app.wathaiqihealth.com -Type A
curl.exe --fail --show-error https://app.wathaiqihealth.com/api/readyz
```

4. Verify the certificate chain, hostname, TLS 1.2/1.3, HSTS/security headers,
   and absence of an HTTP/public 8080 path.

DNS purchase/renewal and Squarespace changes require the domain owner. OCI
cannot take those actions from Terraform in this repository.

## Object upload and CORS acceptance

OCI's documented S3 Compatibility API supports object PUT/GET/HEAD/DELETE but
does not expose `PutBucketCors`/`GetBucketCors`. Do not claim a per-bucket
Origin restriction that cannot be configured. Test the actual browser contract
with a synthetic presigned upload:

1. `OPTIONS` includes `Origin: https://app.wathaiqihealth.com`, method `PUT`,
   and headers `Content-Type, If-None-Match` and receives the required allow
   response.
2. The signed PUT includes `If-None-Match: *` and succeeds once.
3. Reuse/overwrite of the same key is rejected.
4. An unsigned PUT/GET is rejected even if it supplies an allowed Origin.
5. After finalize, the API verifies real size/type and serves only through an
   authenticated in-scope endpoint.

Broad preflight response headers are not a data leak without valid
authorization. Short expiry, unpredictable object keys, create-only conditions,
server-side scope checks, and post-upload validation are the security controls.

## Required verification before real data

Use synthetic accounts/documents until every item passes and evidence is
retained:

- frozen install, generated-client drift check, root typecheck/tests, and
  production build;
- Terraform `fmt -check`, `validate`, reviewed plan, and state access audit;
- database migration forward/rollback rehearsal and an OCI backup/PITR restore
  drill into an isolated target;
- `/api/readyz` through private backend, pre-DNS TLS, and public domain;
- employee mobile-web journey at 390px: sign-in/MFA, upload, metadata, status,
  download, expiration copy, RTL Arabic and LTR English, keyboard/screen-reader;
- owner access, scoped-manager access, cross-facility/tenant denial, employee
  cannot self-verify, and audit event preservation;
- valid upload below 8 MiB, oversized rejection, MIME/signature mismatch,
  replay/overwrite denial, version recovery, orphan cleanup, and quota alerts;
- TLS/security headers, no public bucket/object, no public PostgreSQL/app VNIC,
  no secrets/presigned URLs/document data in logs;
- budget/limit alerts, on-call routing, incident response, key rotation, and
  two-operator break-glass test.

Real credential documents remain prohibited until malware
scanning/quarantine, storage-ingress byte enforcement, audited orphan cleanup,
retention/deletion policy, and backup restore evidence exist. A healthy URL is
not production acceptance.

## External actions required before this path can be activated

- Fund an OCI tenancy; approve estimate, budget, quotas,
  and paid production resources.
- Run Terraform plans/applies with the required compartment and tenancy IAM.
- Create the two Vault secrets and dedicated Object Storage IAM user/customer
  secret key without exposing values.
- Build/push the reviewed image to OCIR and provide its digest.
- Provision database roles, run migrations, and create the first admin through
  the guarded workflow.
- Import/issue the public TLS certificate and change Squarespace DNS.
- Complete the synthetic security/mobile/restore checklist and resolve the
  listed real-data blockers.

No `.github/workflows/deploy-oci.yml` is included. A workflow would require a
verified OCI workload identity/federation design or long-lived API keys. This
repository has neither, and storing an OCI API private key/customer secret in
GitHub would weaken the release. Continue to use the existing CI for build/test;
run OCI release from a named audited operator session until keyless federation
is designed and tested. Until all of those external actions are complete, keep
this OCI path inactive and keep real employee documents out of it.
