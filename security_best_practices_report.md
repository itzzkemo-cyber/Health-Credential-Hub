# Health Credential Hub security review

Date: 2026-08-27

## Release position

The codebase is suitable for a controlled acceptance test with synthetic data
after the Dammam Cloud SQL and Cloud Storage resources are provisioned. It must
not be represented as legally compliant or approved for real employee records
until the operator completes the organizational and privacy controls below.

## Controls implemented

- Production web and API use one HTTPS origin with HttpOnly, Secure, SameSite
  session cookies; JWTs have issuer, audience, algorithm and session-version
  checks.
- Cookie-authenticated mutations require an approved/same origin and a custom
  request marker, in addition to CORS.
- Helmet sets CSP, HSTS, nosniff, referrer, framing and related browser
  protections; Express technology disclosure is disabled.
- Public registration, test-only login, destructive seed, and Google sign-in
  routes are absent from the release.
- TOTP shared secrets are encrypted with AES-256-GCM using a Secret
  Manager-provided key; no long-lived cloud service-account key is required.
- TOTP-enabled accounts fail closed if their encrypted secret is missing, and
  the database enforces that invariant for new writes.
- Upload grants are stored in PostgreSQL, bound to the requester and expire
  after 15 minutes. The API verifies the object store's actual size and MIME
  type before linking a private object to an employee.
- Credential verification uses a monotonic record version and atomic
  compare-and-swap; stale verification decisions return a conflict instead of
  certifying concurrently changed evidence. Soft deletion and its audit event
  commit in one database transaction.
- Cloud deployment uses a private bucket with public access prevention,
  Secret Manager payload replicas in Dammam, database backups/PITR and an
  explicit migration job.

## Open production requirements

### High priority

1. Obtain privacy/legal approval for real workforce documents, including
   purpose, minimization, retention/deletion, data-subject handling, incident
   response and processor agreements for OCR/email.
2. Run tenant-isolation integration tests against a disposable PostgreSQL and
   real private bucket. Current automated tests are unit and route tests and
   do not prove every cross-tenant query against live infrastructure.
3. Enforce the upload byte limit at storage ingress before accepting files from
   untrusted users; post-upload metadata validation does not prevent oversized
   orphan storage or egress cost.
4. Move login, 2FA challenge and OCR rate-limit state to a shared Redis or
   PostgreSQL store before allowing more than one application instance.
5. Configure monitoring/alerts for authentication spikes, repeated 403/429
   responses, migration failures, database saturation and storage errors.

### Medium priority

1. Add an antivirus/content-disarm step for uploaded PDFs/images if the risk
   assessment permits documents to be downloaded to managed endpoints.
2. Add an orphan-object cleanup job and an approved retention window rather
   than leaving failed/abandoned uploads indefinitely.
3. Encrypt or tokenize any additional sensitive database fields selected by
   the organization's data-classification review.
4. Exercise backup restoration and credential-key rotation quarterly.

## Accepted release limitations

- Gemini OCR is optional and disabled until its endpoint/key and processing
  approval are supplied.
- Email is disabled until a verified sender domain and Resend API secret exist.
- Custom domain creation requires the domain owner's DNS action; the generated
  Cloud Run HTTPS URL is used for acceptance testing first.
- Horizontal scaling remains disabled until distributed throttling is added.
