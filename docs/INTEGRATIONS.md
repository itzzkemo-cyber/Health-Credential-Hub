# External integrations: data flow and production controls

This document describes the repository's current implementation, not a claim
that any external provider is approved or provisioned. Credential documents,
employee identity data, OCR requests/results, email content, and authentication
metadata are sensitive workforce information and may incidentally contain
health data.

The released web application is API-backed and does not include test-only login,
synthetic runtime data, or local OCR simulation.
Every enabled integration below must use the reviewed production controls.

## Status at a glance

| Integration                        | Implemented in the repository                                                                                                                        | Provisioned by supplied infrastructure                                                                                                                                                                                  | Production status                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase private Storage (S3 API) | Bounded JPEG/PNG rebuilding and flat PDF image-only reconstruction, private reads and application ACL checks. | The operator configures the private bucket/MIME limits and injects server-only S3 keys into Render. | **Controlled pilot only.** Original bytes are not persisted. Active/encrypted/signed/form PDFs and general files are rejected. Reconstruction is not antivirus certification; worker isolation, Frankfurt transfer, free-tier SLA, backup, retention, orphan cleanup and incident controls remain approval gates. |
| Private Google Cloud Storage (GCS) | Direct upload, private reads, per-object application ACL metadata, and OCR download are implemented.                                                 | Yes. The script creates a private `me-central2` bucket, enables versioning and seven-day soft delete, and attaches a runtime service account.                                                                           | **No-go for real documents in this release.** Signed direct PUT has no provider-ingress byte cap and no malware quarantine. Keep synthetic-only until bounded ingress, AV/quarantine, orphan cleanup, and restore drills are accepted.                                                                                |
| Oracle Object Storage (OCI)        | The same direct-upload/read/ACL/OCR flow is implemented through OCI's S3-compatible API with exact Riyadh endpoint validation.                       | Operator setup is documented for `me-riyadh-1`; account, bucket, customer secret key, database, and container deployment are not created without an approved OCI tenancy.                                               | **No-go for real documents in this release.** Keep disabled until the same bounded-ingress, AV/quarantine, lifecycle, tenancy, IAM/CORS, and synthetic restore gates pass.                                                                                                                                            |
| Gemini OCR                         | Authenticated users can send an authorized stored JPEG/PNG image to `gemini-2.5-flash` as inline Base64 and receive structured extracted fields. PDF suggestions use the separate local worker and never call Gemini. | No. The bootstrap does not create or bind Gemini credentials or select an approved Gemini endpoint. | Optional and off when its endpoint/key are absent. Provider/region/retention approval and reliability controls are incomplete. |
| Resend email                       | Password resets, invitations, employee activation email OTP, expiry alerts, and weekly manager digests are implemented against Resend's HTTPS API. | The Render manifest declares operator-supplied `EMAIL_FROM` and `RESEND_API_KEY`; it cannot create or verify the sender domain. | **Required for employee invitation and activation.** Fail-closed until configured. Approve Resend retention, region/subprocessors, tracking, bounce handling, delivery reconciliation, quotas and incident handling. |
| Signed automation webhook          | A PostgreSQL transactional outbox and optional HMAC-signed worker emit three minimized credential lifecycle events.                                  | Partly. The bootstrap provisions or updates an inert one-shot Cloud Run Job, dedicated worker/scheduler identities, a regional HMAC secret, and a paused five-minute Scheduler job. It does not provision the receiver. | Disabled by default. Supports explicit facility routing, exact-host/public-IP enforcement, idempotency, bounded timeout, retry/backoff, stale-claim recovery, dead-letter retention, and no document/token fields. The recipient remains an operator-approved subprocessor and must verify signatures/replay windows. |

"Implemented" does not mean that the provider has been enabled in a deployed
environment. No FHIR, HL7, SMART on FHIR, regulator API, or other health-data
standard integration is implemented or claimed here.

## 1. Controlled Supabase image and PDF intake

### Current data flow

1. An authenticated browser sends only a JPEG/PNG/PDF filename, byte size, and MIME
   type to `POST /api/storage/uploads/request-url`. The server enforces the
   8 MiB cap, allocates an opaque random path, and records a caller-bound grant
   that expires after 15 minutes.
2. The browser PUTs the original file to the guarded same-origin endpoint with
   its session, CSRF protections, exact content type, byte count, and
   create-only header. The request body is retained only in bounded process
   memory; it is not written to Supabase or a local quarantine file.
   Selecting a PDF first uses an explicit review header: the server processes
   it in memory, returns only bounded field suggestions, releases the temporary
   grant, and writes no object. Saving later obtains a fresh grant and repeats
   the normal sanitizer path before any private object is stored.
3. The server verifies the signature, decodes with strict warning, pixel,
   channel, frame, dimension, concurrency, and timeout limits, corrects
   orientation, and rebuilds a new JPEG without EXIF, GPS, ICC, XMP, comments,
   animation, or bytes appended to the original container.
   PDF follows a separate child-process path: at most 5 pages/8 MiB, decoded
   with local packaged libraries and rebuilt into a new image-only PDF. Active,
   encrypted, signed and form PDFs are rejected. For an explicit PDF review
   request, bounded source text is extracted in the same local worker before
   reconstruction and converted to review-only field suggestions. The raw text
   and both document copies are ephemeral in that review request and are never
   stored, logged, audited, or returned. Selectable
   text is lost from the saved image-only copy; the UI discloses this in
   Arabic/English. No new external processor is contacted.
4. Only the rebuilt JPEG/PDF is written to the private bucket. The server reads it
   back, checks type, size, signature, and SHA-256, then atomically updates the
   still-unclaimed grant to the rebuilt metadata. A failed write, verification,
   or grant update triggers object deletion and a fail-closed response.
5. Credential linkage revalidates the stored object and consumes the grant.
   Private reads and optional external image OCR use the existing owner and
   server-side facility/team scope checks. Local PDF suggestions arrive only in
   the authenticated upload response with `private, no-store`, and the browser
   never receives Supabase S3 keys.

This path accepts only `image/jpeg`, `image/png` and bounded `application/pdf`.
SVG, GIF, WebP, AVIF,
HEIC/HEIF, animated/multi-page images, malformed containers, and
provider-direct upload modes are rejected. Image rewriting removes common
metadata and appended-container payloads, but it is not a general malware
scanner and does not make the free Frankfurt deployment approved healthcare
production. See [`PDF_UPLOAD_SECURITY.md`](PDF_UPLOAD_SECURITY.md) for worker
limits and deployment gates. Arbitrary file intake is not supported.

### Destination, retention, and failure handling

- The active bucket is private and reached through Supabase's S3-compatible
  HTTPS endpoint in Frankfurt. S3 keys are server-only and bypass Storage RLS;
  rotate them after suspected exposure and never place them in frontend code,
  screenshots, logs, CI, or chat.
- The original browser filename stays only in the short-lived PostgreSQL grant;
  it is never an object key or log field. Object names are random UUIDs.
- The owner-only cleanup endpoint covers failed form completion and accepts a
  no-op replay when no actor-owned grant remains. Its `204` response is not
  proof that provider storage has no orphan; automated reconciliation and
  orphan lifecycle are still operator gates. The encrypted backup and local
  restore drill in [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) preserve object bytes
  and ACL metadata but do not constitute a live Supabase backup or provider
  restore. Scheduling, real-provider evidence, capacity alerts and incident
  response remain required before real regulated data.
- `DOCUMENT_UPLOADS_ENABLED=true` requires
  `UPLOAD_SECURITY_PROVIDER=raster-sanitizer`; `/api/readyz` performs a
  processor self-test and proves the private bucket is reachable. Unknown,
  busy, timeout, decode, storage, or integrity outcomes fail closed.

## 2. Private object storage (GCS or OCI Riyadh)

### Current data flow

1. An authenticated browser sends file metadata (`name`, byte `size`, and
   `contentType`) to `POST /api/storage/uploads/request-url`; the file body is
   not sent to the API in this request.
2. The API enforces an 8 MiB maximum and an explicit image/PDF MIME allowlist,
   creates a random object path, returns a V4 write URL valid for 15 minutes,
   and records a 15-minute upload grant in PostgreSQL. The grant binds the
   opaque object path, original filename, declared size/type, and requesting
   user.
3. The browser PUTs the prepared file bytes directly to the selected provider
   with the signed content type and a create-only precondition: GCS uses
   `x-goog-if-generation-match: 0`; OCI uses `If-None-Match: *`.
4. Before a credential links the object, the API reads provider metadata and checks
   the actual size/type against the grant. It consumes the grant once and sets
   private application ACL metadata whose owner is the credential employee.
5. Private reads always pass through the API. Owners are checked against the
   object ACL; manager reads additionally require the linked employee to be in
   the manager's server-side scope. The API streams the object with private
   caching and browser hardening headers.
6. If credential submission fails after upload, the authenticated requester
   can call `DELETE /api/storage/uploads/{uploadId}`. The API locks the caller
   and server-issued grant, verifies that no active or soft-deleted credential
   references the object, deletes it through the configured storage driver,
   removes the grant, and records an audit event without the object identifier.
   All missing, linked, and non-owner cases return the same 404 response.
7. OCR is a separate authorized read: the API downloads the object into server
   memory and then sends it to Gemini as described in the next section.

The selected storage provider receives the file bytes, content type, generated
object name, request metadata inherent to HTTPS access, and custom ACL JSON containing the
numeric local owner ID. The original filename remains in the PostgreSQL upload
grant rather than being used as the object name.

Set `OBJECT_STORAGE_PROVIDER=gcs` for Google Cloud or
`OBJECT_STORAGE_PROVIDER=oci` for Oracle Object Storage only in a reviewed
synthetic acceptance environment. The example leaves the provider blank so a
copied environment fails closed instead of enabling cloud uploads implicitly.

### Destination, region, credentials, and retention

- The supported bootstrap creates Cloud Run, Cloud SQL, and the GCS bucket in
  `me-central2` (Dammam) and configures the regional data-sovereignty endpoint
  `https://storage.me-central2.rep.googleapis.com`. Deployments that do not use
  the reviewed bootstrap must prove their bucket location and endpoint; the
  application configuration alone does not guarantee Dammam residency.
- On Cloud Run, the storage library uses Application Default Credentials from
  the attached service account. The bootstrap grants that identity
  `roles/storage.objectUser` on the bucket and self `signBlob` capability for
  signed upload URLs. A long-lived service-account JSON key is neither required
  nor expected.
- The bootstrap enables uniform bucket-level access, public access prevention,
  versioning, and seven-day soft delete. Seven-day recovery is not the business
  retention schedule. The organization must approve a document retention and
  deletion schedule and implement lifecycle rules that match it.
- The credential DELETE route atomically marks the database record deleted,
  removes its notifications, and writes an audit event, but deliberately does
  not delete the associated storage object. A requester can explicitly remove
  their own unlinked upload even after its grant expires, but replaced files,
  abandoned uploads whose user never retries, object versions, and retained
  soft-deleted credential objects still have no scheduled cleanup job.
  Production must add an auditable lifecycle workflow and test restoration in
  a non-production project.

### Resilience, quotas, and failure behavior

- Upload URLs and grants expire after 15 minutes. URL generation is limited to
  30 requests per 10 minutes by source IP; the limiter is in process and is only
  suitable for the bootstrap's one-instance deployment.
- Create-only signed PUTs plus a unique random object path make accidental
  overwrite retries safe. Upload-grant consumption is an atomic one-time
  transition, and active credential links have a partial unique index. There is
  no application-level retry/backoff or explicit timeout around GCS metadata,
  download, ACL, or signing calls; SDK/provider defaults currently control
  those calls.
- Credential create/update transactions lock the current actor and employee
  scope, consume the database grant, and commit the credential, audit, and
  notification changes together. GCS ACL metadata is still an external side
  effect and cannot be rolled back by PostgreSQL; a provider/commit failure can
  therefore leave a private, unlinked object. The requesting user can retry the
  owner-only cleanup endpoint, but unattended reconciliation and lifecycle
  enforcement remain operator work. The failure does not create an accessible
  credential link.
- The API validates the actual GCS metadata before linking a file, but a signed
  browser PUT cannot enforce the declared 8 MB limit while bytes enter GCS.
  An authenticated user could upload an oversized orphan and consume storage
  before linkage is rejected. Do not open production uploads to untrusted users
  until ingress enforces a byte cap (for example, an approved bounded proxy or
  resumable policy), with short orphan lifecycle cleanup and quota/budget
  alerts. Post-upload validation alone is not a cost-control boundary.
- Missing private-storage configuration fails requests, and `/api/readyz`
  reports not-ready when `PRIVATE_OBJECT_DIR` is absent. Readiness checks that a
  path is configured, not that the bucket is reachable or its security controls
  are correct.
- Production must set quotas/alerts for storage capacity, operations, egress,
  signed-URL generation, and Cloud Run memory. It must also define upload
  concurrency limits and failure recovery for a browser PUT that succeeds while
  the subsequent credential save fails.
- Production must add malware scanning/quarantine before a document becomes
  available to readers, while preserving private ACLs and avoiding document
  bodies or signed URLs in logs.
- Authenticated private document responses use `Cache-Control: private,
no-store, max-age=0`; only explicitly public objects may use cacheable
  responses.
- The production web CSP derives an additional approved HTTPS Google Storage
  origin from `STORAGE_API_ENDPOINT`, so the configured regional
  `storage.me-central2.rep.googleapis.com` endpoint is allowed without opening
  browser connections to arbitrary hosts.
  Before relying on regional signed URLs, verify the URL host emitted by GCS
  matches the configured endpoint; otherwise the browser can receive a valid
  URL whose origin is intentionally absent from `connect-src`.

### Operator setup

1. Use the reviewed `infra/gcp/bootstrap.sh` path or reproduce its private
   bucket, uniform access, public-access prevention, versioning, regional
   endpoint, least-privilege service account, and secret-management controls.
2. Set `GOOGLE_CLOUD_PROJECT`, `PRIVATE_OBJECT_DIR`, and
   `STORAGE_API_ENDPOINT` for the private credential bucket.
3. Restrict bucket CORS to exact production HTTPS origins and PUT plus required
   headers only.
4. Verify owner and scoped-manager reads, cross-employee denial, bounded ingress
   size/type rejection, restore, orphan cleanup, malware handling, lifecycle
   expiry, and audit logging before real documents are accepted. Preflight for
   duplicate active `credentials.file_url` values before applying the partial
   unique-index migration.

### OCI Riyadh operator setup

1. Create or verify an OCI tenancy whose home/active target region is Saudi
   Arabia Central (Riyadh), identifier `me-riyadh-1`.
2. Create a private bucket with public access disabled, versioning/recovery and
   an approved lifecycle policy. Configure the S3 Compatibility API designated
   compartment and a least-privilege application identity/customer secret key.
3. Set `OBJECT_STORAGE_PROVIDER=oci`, `PRIVATE_OBJECT_DIR=/BUCKET/private`,
   `OCI_OBJECT_STORAGE_REGION=me-riyadh-1`, and the exact namespace endpoint
   `https://NAMESPACE.compat.objectstorage.me-riyadh-1.oraclecloud.com`. Inject
   both customer-secret-key values from OCI Vault; never commit them.
4. Restrict bucket CORS to the exact `https://app.wathaiqihealth.com` origin,
   `PUT`, `Content-Type`, and `If-None-Match`. The API rejects non-Riyadh,
   credential-bearing, path-bearing, or lookalike storage endpoints.
5. OCI's compatibility list does not include CopyObject. Updating application
   ACL metadata therefore reads and replaces the same object server-side; the
   8 MiB cap bounds memory. Keep bucket versioning enabled and verify this path
   using synthetic files before real data.
6. Apply the same malware quarantine, byte-cap ingress, orphan cleanup,
   retention, restoration, budget alert, and cross-tenant tests required for
   GCS. Provider selection alone is not production acceptance.

## 3. Gemini OCR

### Current data flow

1. OCR remains unavailable unless `OCR_ENABLED=true`, the target employee's
   facility is in `OCR_FACILITY_ALLOWLIST`, and the HTTPS processor hostname is
   an exact member of `OCR_PROVIDER_HOST_ALLOWLIST`. The authenticated
   `/credentials/ocr/readiness` response applies the same facility scope before
   the web UI offers document reading.
2. After selecting a photo, the user must explicitly choose **Read document**.
   The browser applies the existing image preparation, uploads the result to
   private storage, and submits only the internal `/objects/...` path and the
   in-scope employee ID to `POST /api/credentials/ocr`.
3. The API resolves the private object from the configured provider, requires either the caller's active
   upload grant or an existing owner/scoped-manager ACL decision, validates its
   actual MIME type and maximum 8 MiB size, and downloads the bytes privately.
4. The API Base64-encodes the entire document and sends it inline with an
   extraction prompt to the configured Gemini-compatible base URL, using model
   `gemini-2.5-flash`. The prompt requests document type, holder names, issuer
   names, certificate number, issue/expiry dates, and per-field confidence.
5. The API parses the provider JSON, constrains types/dates/confidence, records
   an audit event that AI extraction was used, and returns extracted values to
   a review card in the browser. No value is copied until the user chooses
   **Apply reviewed suggestions**, and OCR never saves or verifies a credential.
   The user must still correct fields and submit the normal application form.

The external request contains the full credential image (PDF is not accepted by
this external endpoint), which can expose
names, identifiers, license/certificate numbers, dates, photographs, and
incidental health data, plus the system extraction prompt. Data minimization is
currently limited to the file size/type policy and browser image downscaling;
there is no redaction or page selection before transmission.

### Destination, region, credentials, and retention

- The destination is the operator-configured
  `AI_INTEGRATIONS_GEMINI_BASE_URL`, but the runtime requires HTTPS with no URL
  credentials/query/fragment and an exact hostname match in
  `OCR_PROVIDER_HOST_ALLOWLIST`. The repository does not pin or
  attest a Google Cloud project, Vertex AI location, or Saudi processing region
  for OCR. `me-central2` storage does not imply that Gemini processing remains
  in Dammam.
- The API uses `AI_INTEGRATIONS_GEMINI_API_KEY`, initialized lazily only when an
  OCR call occurs. The key must be stored in the deployment secret manager,
  exposed only to the runtime identity, rotated, and restricted where the
  provider supports it. The supplied bootstrap does not provision this secret.
- Provider-side request/log/model-use retention and subprocessors are not
  established by this repository. Before production, the operator must obtain
  the applicable service terms/DPA, exact product and endpoint, processing and
  support regions, retention/deletion behavior, model-training use, access
  controls, and incident process in writing.
- The application does not intentionally persist the raw Gemini response or
  Base64 payload. It returns normalized fields to the client; fields the user
  saves become normal credential records under the application's retention
  policy. Provider-side retention remains separately unknown.

### Resilience, quotas, and failure behavior

- The endpoint limits each user to 20 OCR calls per 10 minutes, but the counter
  is in memory, resets on process restart, and is not shared across instances.
- The Gemini client applies a 45-second timeout to each attempt and permits at
  most two attempts. There is no application idempotency key, durable retry
  ledger, or documented SDK backoff classification. A retry or repeated OCR
  call can create another billed provider request.
- A disabled facility returns HTTP 503 before object storage or the provider is
  touched. A missing/invalid configuration fails operational readiness. A
  provider error, invalid provider JSON, or other extraction failure returns
  HTTP 502 and does not silently fabricate or change form values.
  The uploaded GCS object may still remain and requires normal cleanup/retention.
- Production must establish provider quotas and spend alerts, validate that
  retries are limited to safe transient failures with jitter and a retry
  budget, and add concurrency controls, circuit breaking, and metrics that contain no
  document content, Base64, signed URLs, or credentials.
- OCR failure logs record only a safe error-class name and never serialize the
  provider SDK error object. Before production, keep regression-testing log
  redaction so request bodies, authorization data, sensitive URLs, and
  extracted content remain excluded.

### Operator setup

1. Keep `OCR_ENABLED=false` and both Gemini variables absent until
   legal/privacy/security approval is recorded for the exact paid/private
   endpoint and product. Do not use a free/unpaid processor for real workforce
   documents.
2. Choose and document the processing region, data residency limits, retention,
   model-use terms, quota, and escalation owner. A generic API key plus base URL
   is not sufficient evidence of residency.
3. Set exact positive facility IDs in `OCR_FACILITY_ALLOWLIST`, the exact
   approved destination hostname in `OCR_PROVIDER_HOST_ALLOWLIST`, then add the
   approved secret through Secret Manager; never place it in `.env`,
   logs, source control, screenshots, or support tickets.
4. Set `OCR_ENABLED=true` only after readiness and facility tests pass. Test
   missing configuration, permission denial, timeout, 429, 5xx, malformed
   JSON, oversized/unsupported files, cross-scope object paths, and provider
   outage. Confirm that the UI leaves fields reviewable and never treats OCR as
   authoritative verification.

## 4. Resend email

### Current data flow

The API sends HTTPS POST requests to `https://api.resend.com/emails` containing
the configured sender, recipient email address, bilingual subject, and HTML
body. Four message types are relevant:

- Password reset: recipient address, recipient Arabic/English names, and a raw
  single-use reset link valid for one hour. Only the SHA-256 token hash is kept
  in PostgreSQL, but the raw token necessarily crosses Resend and downstream
  mail infrastructure inside the email.
- Employee invitation: recipient address, invited employee Arabic/English
  names, and a raw single-use registration link valid for 24 hours. Only the
  SHA-256 token hash is stored. The accepting browser supplies the token, the
  code emailed to the locked invitation address, and a new password; role,
  recipient, and organization fields remain server-authoritative.
- Expiry alert: recipient address, credential type label, expiry date, status,
  and days remaining/overdue. It does not attach the credential document.
- Weekly manager digest: manager address/name, team-member Arabic/English names,
  and per-member counts of expired, expiring, and missing credentials. It does
  not include document bodies or certificate numbers.

Expiry/digest dispatch stores an email ledger with user/notification
identifiers, recipient, subject, status, truncated error, and creation time. It
does not store the HTML body in that ledger. Password-reset sends do not use
this ledger.

### Destination, region, credentials, and retention

- Resend's public API is the hard-coded destination. The repository does not
  establish Resend's processing/storage regions, message/log retention,
  subprocessors, support access, or deletion SLA. These must be approved before
  workforce data or reset links are sent.
- `RESEND_API_KEY` and `EMAIL_FROM` are server-only. Delivery additionally
  requires the exact opt-in `EMAIL_ALERTS_DISABLED=0`; missing or malformed
  configuration remains off. The Render manifest enables the integration but
  declares `EMAIL_FROM` and `RESEND_API_KEY` as operator-supplied values, so
  readiness fails closed until both are present and valid.
- The operator must verify the sender domain and publish/monitor SPF, DKIM, and
  DMARC. Seeded fixture domains are suppressed by the application and must never
  receive real mail.
- Neither provider retention nor an application retention/deletion schedule for
  `email_log` and expired password-reset-token rows is implemented here. Define
  both, including security-log exceptions and deletion evidence.
- Employee-invitation rows contain workforce profile and organization data.
  Every API process starts a bounded hourly cleanup with a process-local
  overlap guard. It deletes at most 200 rows per run once expiry, revocation, or
  acceptance is at least 30 days old. The cleanup selects and logs no recipient
  or token data; durable audit events remain separate. Operators must monitor
  backlog and retain deletion evidence because this application schedule does
  not define Resend's provider-side retention.

### Resilience, quotas, and failure behavior

- Each provider call has a 30-second timeout. One bounded retry is made for a
  network failure, HTTP 429, or HTTP 500/502/503/504, using the same hashed
  Resend idempotency key so an ambiguous first acceptance cannot create a
  duplicate within the provider's idempotency window. Expiry and
  digest delivery uses a database claim-first ledger: unique indexes allow only
  one attempt per notification and one digest per manager/week across
  concurrent dispatchers.
- Employee-invitation delivery is fail-closed. If Resend delivery fails, the
  active invitation is revoked and the revocation audit event is committed in
  the same database transaction. If audit persistence itself fails, the API
  makes a direct fallback revocation and emits only an invitation ID in its
  operational error signal; it never logs the recipient or raw token.
- Configuration/authorization failures (including HTTP 401/403) release the
  claim so the message stays pending after configuration is repaired. Other
  provider errors are recorded as failed and are not retried. An ambiguous
  timeout after both idempotent attempts can still be marked failed; no
  delivery-status reconciliation/webhook exists.
- The scheduler runs hourly inside the API process, processes at most 200
  pending alerts per query, sends sequentially, and uses an in-process overlap
  guard. It is not a durable queue. The bootstrap's one-instance cap avoids some
  scheduler ambiguity, but restarts can delay sends.
- Password recovery is limited to five requests per source IP per hour using an
  in-memory limiter. Provider sending quotas, bounce/complaint limits, and spend
  alerts are not encoded in the application.
- Production needs a durable job/queue strategy, documented retry classes and
  dead-letter/manual replay procedure, provider idempotency/reconciliation where
  available, bounce/complaint/suppression processing, and quota/backlog alerts.
- Provider response bodies, recipient addresses, message bodies, reset URLs,
  and idempotency keys are not written to application logs or stored failure
  text. Stored failures are limited to a bounded error name/code class.

### Operator setup

1. Obtain subprocessor/privacy approval for the exact Resend service and
   regions; verify a production sender domain.
2. Store `RESEND_API_KEY` in Secret Manager, grant it only to the runtime
   service account, set `EMAIL_FROM`, and only then set
   `EMAIL_ALERTS_DISABLED=0`.
3. Ensure `PUBLIC_APP_URL` is the canonical HTTPS origin before password-reset
   mail is enabled. The API readiness check reports `emailDelivery` as
   `disabled` or `configured`, and returns 503 with `misconfigured` when an
   invalid opt-in is attempted; it never exposes the sender or key.
4. Disable Resend click and open tracking for the sender domain. Password reset
   bearer tokens are kept in URL fragments so they do not enter HTTP request
   logs, but link-rewriting/tracking must remain off.
5. Configure bounce/complaint monitoring and a suppression/manual-review
   procedure in Resend. The application does not yet accept a Resend webhook;
   do not add one without signature verification, replay protection, and a
   documented retention policy.
6. Test fixture suppression, inactive users, 401/403 recovery, timeout/429/5xx,
   duplicate scheduler execution, backlog catch-up, reset-token expiry and
   single use, bounce/complaint response, and log redaction.

## 5. Resend employee activation email OTP

### Current data flow and security boundary

1. A stepped-up administrator creates an employee invitation. Phone is optional
   and, when supplied, remains unverified. The initial invitation email carries
   the single-use registration token in its URL fragment.
2. The invited employee submits only the token to
   `POST /api/auth/invitation-email-otp/start`. The API revalidates the active
   inviter, facility, department, supervisor and invitation, then takes a
   durable PostgreSQL dispatch claim.
3. The API generates a CSPRNG six-digit code and sends it through the existing
   Resend adapter only to the locked invitation email. Caller-supplied recipient
   addresses are rejected. PostgreSQL stores a random salt and a
   `SESSION_SECRET`-derived, domain-separated HMAC bound to the token digest,
   challenge ID, normalized invitation email, salt and code.
4. Account activation submits token, code and a new password. A single database
   transaction revalidates scope, consumes the challenge, creates the employee,
   consumes the invitation, and writes an audit event. No browser session is
   issued and `phone_verified_at` remains null.

Expired/revoked invitations, wrong/expired codes, exhausted attempts, replay,
recipient injection and parallel verification fail closed. TOTP remains the
second factor for the immutable account selected by `PROTECTED_MFA_USER_ID`;
other administrators use password re-authentication for sensitive operations.
Email activation does not replace either control. Logs may contain internal invitation/challenge IDs and a
bounded error class, but never email, OTP, raw invitation token, credentials or
provider response body.

### Retention and failure handling

- Challenges expire after ten minutes, enforce a 60-second resend cooldown,
  allow five sends per hour and five wrong-code attempts, and cascade with the
  invitation. Codes are never stored in plaintext.
- The 75-second durable dispatch lease exceeds the adapter's bounded retry path.
  A stable idempotency key is derived per code generation. Provider failure
  clears code material and cannot create an account.
- Rotating `SESSION_SECRET` deliberately invalidates pending codes. This is
  bounded by their ten-minute expiry and must be included in the rotation runbook.
- Migration `0016_black_silver_centurion.sql` fails closed every unconsumed
  challenge from the retired SMS flow; consumed audit history is retained.

### Operator setup

1. Approve Resend for the invitation/activation data flow, verify the dedicated
   sender domain, and disable click/open tracking.
2. Store `RESEND_API_KEY` and `EMAIL_FROM` in the deployment secret manager and
   set `EMAIL_ALERTS_DISABLED=0` only after verification.
3. Apply migration `0016`, deploy, and verify `/api/readyz` reports
   `emailDelivery` and `invitationEmailOtp` as `configured`.
4. Test successful, wrong, expired, replayed and parallel codes, cooldown/send
   exhaustion, provider outage, and log redaction before real employee rollout.

## 6. Durable workflow automation / n8n-compatible webhook

### Scope and safe defaults

Workflow automation has two independent, disabled-by-default switches:

- `AUTOMATION_OUTBOX_ENABLED=true` makes credential create and verification
  changes write an outbox row in the same PostgreSQL transaction as the source
  record. The API does not need the webhook secret.
- `AUTOMATION_WEBHOOK_ENABLED=true` enables the separate worker. It requires an
  HTTPS `AUTOMATION_WEBHOOK_URL` and a canonical Base64 HMAC secret containing
  at least 32 random bytes. HTTP is accepted only for localhost outside
  production. The worker refuses to start unless
  `AUTOMATION_OUTBOX_ENABLED=true` is also set, so expiry scanning cannot bypass
  the common feature gate.
- `AUTOMATION_FACILITY_ALLOWLIST` is a required comma-separated list of
  positive facility IDs whenever event production is enabled. There is no
  wildcard. Credential create/update enqueue, expiry scans, and delivery claims
  all apply this same database-level boundary.
- Delivery additionally requires
  `AUTOMATION_WEBHOOK_MODE=SINGLE_CONTROLLER` to acknowledge that one receiver
  is privileged across the listed facilities, plus an exact
  `AUTOMATION_WEBHOOK_HOST_ALLOWLIST`. Wildcards, schemes, ports, and paths are
  rejected in that host list.

The worker may run as a scheduled one-shot Cloud Run Job
(`AUTOMATION_WORKER_MODE=once`) or as a dedicated continuously polling worker
(`continuous`). Do not run it inside the public API process. The shipped Google
Cloud bootstrap provisions or updates the one-shot job with its own identity,
Cloud SQL access, and the HMAC secret while keeping both switches false by
default. It also provisions a five-minute Cloud Scheduler invocation in
`me-central2` under a separate identity with `roles/run.invoker` only on this
job; the schedule is paused by default. It resumes and runs one initial worker
cycle only when an operator explicitly supplies all reviewed automation
settings.

### Event contract and data minimization

The exact JSON envelope is:

```json
{
  "id": "outbox-uuid-used-for-idempotency",
  "type": "credential.created | credential.verification_changed | credential.expiry_due",
  "occurredAt": "2026-08-19T12:00:00.000Z",
  "facilityId": 17,
  "data": {
    "credentialId": 42,
    "employeeId": 7,
    "credentialType": "BLS"
  }
}
```

`credential.verification_changed` additionally has `isVerified`.
`credential.expiry_due` additionally has `expiryDate`, `dueInDays`, and the
crossed `thresholdDays` (`90, 60, 30, 15, 7, 1, 0`). A delayed worker emits the
closest crossed threshold and database uniqueness prevents repeating that
threshold for the same credential expiry date. Renewing the credential changes
the deduplication key so the new lifecycle can emit its own due events.

The payload validator rejects unexpected keys. In particular, events never
contain a document body/path, original filename, presigned URL, QR token,
certificate number, OCR body/result, employee name/email/phone, password,
session token, or TOTP material. `facilityId` is the affected tenant, not a
value derived from a cross-facility actor.

### Signature, replay, and idempotency

The worker serializes the exact body once and sends:

- `Idempotency-Key` and `X-Health-Credential-Event-Id`: the outbox UUID.
- `X-Health-Credential-Event-Type`: the event type.
- `X-Health-Credential-Timestamp`: Unix seconds.
- `X-Health-Credential-Signature`: `sha256=<hex HMAC>`, calculated over
  `<timestamp>.<exact raw request body>`.

The receiver must read the raw bytes before JSON parsing, calculate HMAC-SHA256
with the Secret Manager value, compare in constant time, reject timestamps
outside an approved short window (recommended five minutes), and atomically
deduplicate the event ID before starting a workflow. Returning any non-2xx
status leaves the event undelivered. Never return provider secrets or document
content in an error response.

Before production delivery, the URL hostname must exactly match the configured
host allowlist. The worker performs DNS resolution inside the actual HTTPS
connection lookup, rejects any private, loopback, link-local, documentation, or
multicast result, and keeps the original hostname for TLS SNI/certificate and
Host validation. This avoids a separate DNS-check/fetch rebinding window.
Also apply outbound firewall/egress policy to the approved receiver where the
platform supports it; application checks do not replace network controls.

### Delivery, failure, and retention

- Claims use PostgreSQL row locks with `SKIP LOCKED`; duplicate delivery is
  still possible if the receiver succeeds and the worker crashes before
  marking the row. The event ID is therefore the correctness boundary.
- Each event is claimed immediately before its own request. A batch never
  shares one lock deadline across sequential network calls, and the five-minute
  default lock remains greater than twice the maximum request timeout.
- The default request timeout is 10 seconds. Failures retry from 30 seconds
  with exponential backoff capped at one hour, for eight attempts by default.
  HTTP 408/409/425/429/5xx and network/timeout failures retry; other 4xx
  responses are treated as permanent configuration/contract rejection.
  Bounded `Retry-After` values are honored up to one hour.
- A stale claim can be recovered after five minutes. An exhausted stale claim
  is explicitly dead-lettered rather than becoming permanently stuck.
- Invalid payloads fail closed and are dead-lettered without an outbound call.
  Logs contain event/facility IDs and bounded error codes, never response bodies
  or integration secrets.
- Pending events older than seven days are dead-lettered without delivery by
  default, preventing a newly enabled receiver from receiving an unbounded old
  backlog. Before every delivery, the worker rechecks the credential: deleted
  records, inactive/transferred employees, mismatched tenant, superseded
  verification state, and replaced expiry dates are suppressed.
- Processed and dead-letter rows are deleted after 30 days by default. Approve
  that value against audit/incident requirements before production; the
  authoritative credential/audit records are not deleted by this cleanup. Each
  delivered or finally discarded event is also written transactionally to the
  append-only `automation_delivery_log` with only event/facility/type/status,
  attempt count, a safe error code, and timestamp. Worker cleanup does not
  delete this disclosure ledger.

For Saudi data residency, prefer an operator-controlled n8n deployment whose
compute, database, backups, logs, and encryption keys all remain in Dammam
(`me-central2`) and whose ingress accepts only the worker identity/network where
practical. A public n8n/webhook SaaS endpoint is a new external data recipient:
do not enable it until legal/privacy review confirms region, retention,
subprocessors, breach terms, access controls, and deletion procedures. n8n
workflow execution logs must not persist the full event longer than approved.

The configured webhook is a cross-facility privileged recipient because a
single worker can deliver events for every facility. Restrict receiver access,
workflow editing, and event inspection accordingly. Give n8n only the webhook
verification secret: never provide it with Health Credential Hub administrator
credentials, application sessions, database credentials, storage access, or
document URLs. Rotate the HMAC secret through an overlap procedure that keeps
verification available while the worker and receiver move to the new value.

### Operator sequence

1. Apply migration `0005_automation_outbox.sql`.
2. Provision the receiver and HMAC secret. Test signature rejection, replay,
   duplicate ID, timeout, 5xx retry, and dead-letter alerting with synthetic
   data.
3. Rerun the bootstrap, or update the provisioned
   `health-credential-hub-automation` job, with the approved HTTPS
   `AUTOMATION_WEBHOOK_URL`, its exact host allowlist,
   `AUTOMATION_WEBHOOK_MODE=SINGLE_CONTROLLER`, the reviewed facility ID list,
   and both automation switches set to `true`. Keep the HMAC secret mounted
   only on that job. Enable event production only when monitoring is ready,
   otherwise pending rows can accumulate until the worker next runs.
4. Confirm the bootstrap-created Scheduler job resumed at the approved
   five-minute cadence, or keep it paused and trigger the worker manually. Its
   identity must retain only Job-level `roles/run.invoker`.
5. Monitor pending age, attempt count, dead-letter count, delivery latency,
   Cloud SQL load, and receiver failures. The repository does not currently
   ship alert policies or an operator re-drive command for dead-letter rows.

For the supported Google Cloud layout, the bootstrap-created job already uses
the reviewed application image, its own least-privilege identity, Cloud SQL,
`DATABASE_URL`, and the HMAC secret; the public API cannot access that HMAC
secret. Set the non-secret worker variables explicitly on every bootstrap or
release update. Run a one-shot cycle with:

```bash
gcloud run jobs execute "health-credential-hub-automation" \
  --region="me-central2" --wait
```

The bootstrap-created Scheduler job uses an authenticated invocation and is
paused whenever webhook delivery is disabled. An operator may keep it paused
and deploy the same entry point as a dedicated worker service using
`AUTOMATION_WORKER_MODE=continuous`. The public API service must not receive the
webhook HMAC secret.

## Cross-integration production gate

Do not enable external integrations with real workforce data until all of the
following have named owners and evidence:

- approved privacy notice, processing purpose/legal basis, data inventory,
  retention/deletion schedule, data-subject handling, incident response, and
  subprocessor/DPA review;
- confirmed region and cross-border-transfer position for each provider (GCS
  location must not be used as evidence for Gemini or Resend);
- least-privilege runtime identity, secrets in Secret Manager, rotation and
  revocation runbooks, and no secrets in source, images, logs, or support data;
- bounded timeouts, explicit retry/idempotency rules, quota/spend/backlog alerts,
  provider-outage behavior, and restore/reconciliation drills;
- log redaction tests covering authorization, cookies, reset links, API keys,
  document bodies/Base64, signed URLs, OCR content, and
  unnecessarily identifying recipient data;
- an acceptance test using synthetic documents before any real credential is
  uploaded or transmitted.

## Repository evidence

The assessment above is based on these implementation sources:

- GCS: [`objectStorage.ts`](../artifacts/api-server/src/lib/objectStorage.ts),
  [`storage.ts`](../artifacts/api-server/src/routes/storage.ts),
  [`uploadSecurity.ts`](../artifacts/api-server/src/lib/uploadSecurity.ts),
  [`upload-grants.ts`](../lib/db/src/schema/upload-grants.ts), and
  [`bootstrap.sh`](../infra/gcp/bootstrap.sh).
- Gemini OCR: [`credentials.ts`](../artifacts/api-server/src/routes/credentials.ts)
  and [`client.ts`](../lib/integrations-gemini-ai/src/client.ts).
- Resend: [`sender.ts`](../artifacts/api-server/src/lib/email/sender.ts),
  [`dispatch.ts`](../artifacts/api-server/src/lib/email/dispatch.ts),
  [`scheduler.ts`](../artifacts/api-server/src/lib/email/scheduler.ts),
  [`templates.ts`](../artifacts/api-server/src/lib/email/templates.ts), and
  [`email-log.ts`](../lib/db/src/schema/email-log.ts).
- Safe configuration defaults: [`.env.example`](../.env.example) and
  [`GOOGLE_CLOUD_DEPLOYMENT.md`](./GOOGLE_CLOUD_DEPLOYMENT.md).
