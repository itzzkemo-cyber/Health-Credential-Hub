# Oracle Cloud Riyadh deployment path

This directory is the reviewed alternative to the CNTXT-gated Google Cloud
deployment. It targets OCI Saudi Arabia Central (Riyadh), region
`me-riyadh-1`, and keeps the public application at
`https://app.wathaiqihealth.com`.

No Oracle account, paid resource, DNS change, or production secret is created
by files in this directory. Run the preflight only after the tenancy owner has
finished Oracle account verification and explicitly approved the expected
charges.

## Target architecture

- OCI Load Balancer or Network Load Balancer terminates TLS for
  `app.wathaiqihealth.com` and forwards only to the application container.
- OCI Container Instances runs the repository's reviewed production image in
  `me-riyadh-1`. A private OKE deployment is an optional later scale path.
- OCI Database with PostgreSQL is private and reachable only from the
  application subnet/security group. Runtime and migration database roles must
  remain separate.
- OCI Object Storage stores credential files in a private Riyadh bucket. The
  application uses OCI's S3-compatible path-style endpoint and never exposes a
  bucket read URL to users.
- OCI Vault holds the session/TOTP keys, database password, storage customer
  secret key, and optional integration secrets. Do not place secret values in
  the container image, GitHub variables, DNS, logs, or committed env files.
- OCI Logging/Monitoring receives application infrastructure signals. Logs
  must not contain document bodies, OCR Base64, tokens, passwords, presigned
  URLs, or sensitive environment values.

Official region and storage references:

- <https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm>
- <https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm>
- <https://docs.oracle.com/en-us/iaas/Content/postgresql/overview.htm>

## Operator order

1. Create one OCI tenancy with Saudi Arabia as the billing country and select
   **Saudi Arabia Central (Riyadh)** as the home region. Do not create duplicate
   free-tier accounts.
2. Install/configure the OCI CLI for an administrator, then set
   `OCI_CLI_REGION=me-riyadh-1` and `OCI_COMPARTMENT_ID` locally. Run
   `powershell -File infra/oci/preflight.ps1`; it is read-only and prints no
   account IDs or secrets.
3. Create separate application, migration, and automation identities with
   least privilege. Create the Vault and private network before the database or
   container.
4. Provision OCI Database with PostgreSQL privately, apply reviewed Drizzle
   migrations with the migration identity, and run the guarded first-admin job.
   The bootstrap password must be changed immediately and MFA enrolled with
   two-operator evidence.
5. Create a private Object Storage bucket in `me-riyadh-1`, enable versioning
   and an approved recovery/lifecycle policy, set the S3 Compatibility API
   designated compartment, and create a customer secret key for the application
   identity. Store both values in Vault.
6. Deploy the application with values based on `app.env.example`. Keep Demo,
   self-registration, seed, Google auto-provisioning, email, OCR, and automation
   fail-closed until each dependency is approved and tested.
7. Restrict bucket CORS to `https://app.wathaiqihealth.com`, method `PUT`, and
   headers `Content-Type` and `If-None-Match`. Keep bucket/public-object access
   disabled.
8. Complete synthetic tests: upload under 8 MiB, reject oversized/type mismatch,
   owner read, scoped-manager read, cross-tenant denial, metadata replacement,
   version restore, migration rollback, and backup restore. Add malware
   quarantine and orphan cleanup before accepting real documents.
9. Only after the application endpoint passes `/api/readyz` and the full
   release checklist, add the Squarespace DNS record for
   `app.wathaiqihealth.com`, issue TLS, set the canonical origins, and run a
   custom-domain smoke test. Preserve all Google Workspace MX/SPF/DKIM records.

## Storage configuration

The application driver is opt-in:

```text
OBJECT_STORAGE_PROVIDER=oci
PRIVATE_OBJECT_DIR=/wathaiqi-production-private/private
OCI_OBJECT_STORAGE_REGION=me-riyadh-1
OCI_OBJECT_STORAGE_ENDPOINT=https://NAMESPACE.compat.objectstorage.me-riyadh-1.oraclecloud.com
OCI_OBJECT_STORAGE_ACCESS_KEY_ID=<Vault reference at deployment>
OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY=<Vault reference at deployment>
```

The API validates the exact Riyadh endpoint, uses `If-None-Match: *` for
create-only uploads, validates actual size/type after upload, and continues to
serve every private file through authenticated server-side scope checks.

## Production gates that infrastructure alone does not solve

- Legal/trademark approval for the public name and approved privacy terms.
- Malware scanning/quarantine and storage-ingress byte enforcement.
- Auditable orphan cleanup, document deletion/retention, backup and restore
  drills, quotas, budgets, alerts, and incident response.
- Subprocessor/DPA/region approval before Gemini, Resend, Google OAuth, or an
  external n8n receiver is enabled.
- A staging run with synthetic data. A local Demo or successful build is not
  production acceptance.
