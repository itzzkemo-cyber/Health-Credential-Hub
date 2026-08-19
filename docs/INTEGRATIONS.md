# External integrations: data flow and production controls

This document describes the repository's current implementation, not a claim
that any external provider is approved or provisioned. Credential documents,
employee identity data, OCR requests/results, email content, and authentication
metadata are sensitive workforce information and may incidentally contain
health data.

The browser-only Showcase is a separate mode: it uses synthetic data, keeps a
selected file in the browser tab's memory, simulates OCR locally, and does not
call Cloud Storage, Gemini, Resend, or Google OAuth. See
[`SHOWCASE.md`](./SHOWCASE.md). The sections below apply to the API-backed
application.

## Status at a glance

| Integration                        | Implemented in the repository                                                                                                          | Provisioned by the supplied Google Cloud bootstrap                                                                                            | Production status                                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private Google Cloud Storage (GCS) | Direct upload, private reads, per-object application ACL metadata, and OCR download are implemented.                                   | Yes. The script creates a private `me-central2` bucket, enables versioning and seven-day soft delete, and attaches a runtime service account. | Supported deployment path, but document lifecycle deletion, orphan cleanup, malware scanning, and restore drills remain operator work.                                                                                                     |
| Gemini OCR                         | Authenticated users can send an authorized stored file to `gemini-2.5-flash` as inline Base64 and receive structured extracted fields. | No. The bootstrap does not create or bind Gemini credentials or select an approved Gemini endpoint.                                           | Optional and off when its endpoint/key are absent. Provider/region/retention approval and reliability controls are incomplete.                                                                                                             |
| Resend email                       | Password resets, expiry alerts, and weekly manager digests are implemented against Resend's HTTPS API.                                 | No. The bootstrap explicitly deploys with email disabled and does not create the Resend secret.                                               | Optional and fail-closed until an operator enables it. Subprocessor approval, data-region/retention confirmation, bounce handling, and delivery reconciliation remain required.                                                            |
| Google OAuth                       | Authorization-code login, verified-email linking, local session issuance, and local 2FA continuation are implemented.                  | No. The bootstrap does not create an OAuth client or bind its secret.                                                                         | Optional when client credentials and the canonical public URL are configured. Production auto-provisioning is disabled in code. Bounded timeouts are implemented; retry decisions and account unlink/lifecycle procedures remain required. |

"Implemented" does not mean that the provider has been enabled in a deployed
environment. No FHIR, HL7, SMART on FHIR, regulator API, or other health-data
standard integration is implemented or claimed here.

## 1. Private Google Cloud Storage

### Current data flow

1. An authenticated browser sends file metadata (`name`, byte `size`, and
   `contentType`) to `POST /api/storage/uploads/request-url`; the file body is
   not sent to the API in this request.
2. The API enforces an 8 MiB maximum and an explicit image/PDF MIME allowlist,
   creates a random object path, returns a V4 write URL valid for 15 minutes,
   and records a 15-minute upload grant in PostgreSQL. The grant binds the
   opaque object path, original filename, declared size/type, and requesting
   user.
3. The browser PUTs the prepared file bytes directly to GCS with the signed
   content type and `x-goog-if-generation-match: 0`. The generation precondition
   makes the write create-only rather than overwrite-capable.
4. Before a credential links the object, the API reads GCS metadata and checks
   the actual size/type against the grant. It consumes the grant once and sets
   private application ACL metadata whose owner is the credential employee.
5. Private reads always pass through the API. Owners are checked against the
   object ACL; manager reads additionally require the linked employee to be in
   the manager's server-side scope. The API streams the object with private
   caching and browser hardening headers.
6. OCR is a separate authorized read: the API downloads the object into server
   memory and then sends it to Gemini as described in the next section.

GCS receives the file bytes, content type, generated object name, request
metadata inherent to HTTPS/GCS access, and custom ACL JSON containing the
numeric local owner ID. The original filename remains in the PostgreSQL upload
grant rather than being used as the GCS object name.

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
  not delete the associated GCS object. Replaced files, abandoned uploads,
  expired upload grants, object versions, and retained soft-deleted objects
  have no application cleanup job. Production must add an auditable
  orphan/deletion workflow and test restoration in a non-production project.

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
  therefore leave a private, unlinked object for the required orphan-cleanup
  process, but it does not create an accessible credential link.
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
   `STORAGE_API_ENDPOINT`; keep `PUBLIC_OBJECT_SEARCH_PATHS` separate from the
   private root.
3. Restrict bucket CORS to exact production HTTPS origins and PUT plus required
   headers only.
4. Verify owner and scoped-manager reads, cross-employee denial, bounded ingress
   size/type rejection, restore, orphan cleanup, malware handling, lifecycle
   expiry, and audit logging before real documents are accepted. Preflight for
   duplicate active `credentials.file_url` values before applying the partial
   unique-index migration.

## 2. Gemini OCR

### Current data flow

1. An authenticated user submits only an internal `/objects/...` path to
   `POST /api/credentials/ocr`.
2. The API resolves the private object, requires either the caller's active
   upload grant or an existing owner/scoped-manager ACL decision, validates its
   actual MIME type and maximum 8 MiB size, and downloads the bytes from GCS.
3. The API Base64-encodes the entire document and sends it inline with an
   extraction prompt to the configured Gemini-compatible base URL, using model
   `gemini-2.5-flash`. The prompt requests document type, holder names, issuer
   names, certificate number, issue/expiry dates, and per-field confidence.
4. The API parses the provider JSON, constrains types/dates/confidence, records
   an audit event that AI extraction was used, and returns extracted values to
   the browser for human review. The user must still save/correct credential
   fields through the normal application flow.

The external request contains the full credential image/PDF, which can expose
names, identifiers, license/certificate numbers, dates, photographs, and
incidental health data, plus the system extraction prompt. Data minimization is
currently limited to the file size/type policy and browser image downscaling;
there is no redaction or page selection before transmission.

### Destination, region, credentials, and retention

- The destination is whatever operator-configured
  `AI_INTEGRATIONS_GEMINI_BASE_URL` resolves to. The repository does not pin or
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
- A missing endpoint/key, provider error, invalid provider JSON, or other
  extraction failure returns HTTP 502 and does not silently fabricate values.
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

1. Keep both Gemini variables absent until legal/privacy/security approval is
   recorded for the exact endpoint and product.
2. Choose and document the processing region, data residency limits, retention,
   model-use terms, quota, and escalation owner. A generic API key plus base URL
   is not sufficient evidence of residency.
3. Add the approved secret through Secret Manager; never place it in `.env`,
   logs, source control, screenshots, or support tickets.
4. Test missing configuration, permission denial, timeout, 429, 5xx, malformed
   JSON, oversized/unsupported files, cross-scope object paths, and provider
   outage. Confirm that the UI leaves fields reviewable and never treats OCR as
   authoritative verification.

## 3. Resend email

### Current data flow

The API sends HTTPS POST requests to `https://api.resend.com/emails` containing
the configured sender, recipient email address, bilingual subject, and HTML
body. Three message types are relevant:

- Password reset: recipient address, recipient Arabic/English names, and a raw
  single-use reset link valid for one hour. Only the SHA-256 token hash is kept
  in PostgreSQL, but the raw token necessarily crosses Resend and downstream
  mail infrastructure inside the email.
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
  configuration remains off. The supplied bootstrap sets
  `EMAIL_ALERTS_DISABLED=1` and does not provision the Resend key.
- The operator must verify the sender domain and publish/monitor SPF, DKIM, and
  DMARC. Seeded fixture domains are suppressed by the application and must never
  receive real mail.
- Neither provider retention nor an application retention/deletion schedule for
  `email_log` and expired password-reset-token rows is implemented here. Define
  both, including security-log exceptions and deletion evidence.

### Resilience, quotas, and failure behavior

- Each provider call has a 30-second timeout and no automatic retry. Expiry and
  digest delivery uses a database claim-first ledger: unique indexes allow only
  one attempt per notification and one digest per manager/week across
  concurrent dispatchers.
- Configuration/authorization failures (including HTTP 401/403) release the
  claim so the message stays pending after configuration is repaired. Other
  provider errors are recorded as failed and are not retried. An ambiguous
  timeout after Resend accepted a message can therefore be marked failed; no
  provider idempotency key or delivery-status reconciliation/webhook exists.
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
- Provider response text can enter stored error text and error objects plus
  recipient addresses enter logs on send failure. Review this against the
  logging policy; sanitize provider details and avoid logging addresses or any
  message/reset-token content.

### Operator setup

1. Obtain subprocessor/privacy approval for the exact Resend service and
   regions; verify a production sender domain.
2. Store `RESEND_API_KEY` in Secret Manager, grant it only to the runtime
   service account, set `EMAIL_FROM`, and only then set
   `EMAIL_ALERTS_DISABLED=0`.
3. Ensure `PUBLIC_APP_URL` is the canonical HTTPS origin before password-reset
   mail is enabled.
4. Test fixture suppression, inactive users, 401/403 recovery, timeout/429/5xx,
   duplicate scheduler execution, backlog catch-up, reset-token expiry and
   single use, bounce/complaint response, and log redaction.

## 4. Google OAuth

### Current data flow

1. The API redirects the browser to Google's authorization endpoint requesting
   `openid email profile`. A signed 10-minute `state` token and matching secure,
   HTTP-only, SameSite=Lax nonce cookie bind the callback to the initiating
   browser.
2. Google redirects an authorization code to the canonical
   `/api/auth/google/callback`. The API sends the code, client ID, client secret,
   redirect URI, and authorization-code grant type to
   `https://oauth2.googleapis.com/token`.
3. The API sends the returned bearer access token to
   `https://www.googleapis.com/oauth2/v3/userinfo` and receives `sub`, email,
   email-verification status, display name, and picture URL.
4. The API does not persist Google access/refresh tokens. It stores the Google
   subject identifier and may store the picture URL; email and names already
   form part of the local user record. It links an existing account only when
   Google reports the email as verified and refuses a conflicting Google ID.
5. Google login replaces only the password factor. An inactive account is
   refused, and locally enabled TOTP is still required before a session is
   issued.

### Destination, region, credentials, and retention

- Authorization, token, and userinfo go to Google's public global endpoints.
  No regional endpoint or Saudi processing guarantee is configured. Google's
  OAuth/user-profile retention and support access must be assessed under the
  organization's Google terms/DPA.
- `GOOGLE_CLIENT_SECRET` is server-only; `GOOGLE_CLIENT_ID` is public by design
  but still managed configuration. Both are absent by default and the flow
  returns a configuration error when either or the canonical public URL is
  missing. The supplied bootstrap does not create an OAuth client or secret.
- The local user record retains `googleId`, email/name, and optional avatar URL
  for the account lifetime. There is no implemented Google unlink, profile
  refresh, or provider-deprovisioning workflow; production must define account
  unlink/deletion and stale-avatar handling.

### Resilience, quotas, and failure behavior

- Start and callback endpoints are limited to 20 requests per source IP per 10
  minutes using the shared in-memory limiter. This is one-instance protection,
  not a cluster-wide control.
- Token and userinfo fetches each have a 15-second timeout and no automatic
  retry. OAuth code exchange is not generally safe to retry blindly because
  codes are short-lived and single-use; userinfo can use a bounded transient
  retry while the access token remains valid.
- Failures redirect to a small public error code and do not expose tokens or
  provider bodies. The provider access token is held only in process memory.
  Local sessions use an HTTP-only cookie and local TOTP remains enforced.
- Production auto-provisioning is unconditionally disabled by the current code,
  even if `GOOGLE_AUTO_PROVISION_ENABLED=true`; an unknown Google account is
  refused. In non-production, auto-provisioning is possible unless the flag is
  exactly `false`, so keep the safe `.env.example` value and never reuse such an
  environment with real organizational data.
- Production must document Google project quotas, consent-screen status,
  authorized domains, client-secret rotation, timeout/error metrics, and an
  incident/revocation procedure. Logs must continue to exclude codes, access
  tokens, cookies, `state`, and profile payloads.

### Operator setup

1. Create a dedicated production OAuth client and consent configuration under
   an organization-controlled Google Cloud project; request only
   `openid email profile`.
2. Register the exact canonical HTTPS callback
   `${PUBLIC_APP_URL}/api/auth/google/callback`; configure
   `PUBLIC_APP_URL`, `GOOGLE_CLIENT_ID`, and the Secret-Manager-backed
   `GOOGLE_CLIENT_SECRET`.
3. Keep `GOOGLE_AUTO_PROVISION_ENABLED=false`. Pre-create and scope employee
   accounts through the approved administrator process; test verified-email
   linking, conflicting IDs, inactive accounts, cancellation, stale/replayed
   state, local 2FA, and secret revocation.
4. Add provider health/error metrics, unlink and deprovisioning procedures,
   and a documented emergency disable method before enabling the button for
   production users. Validate the 15-second timeout behavior against the
   approved network path.

## Cross-integration production gate

Do not enable external integrations with real workforce data until all of the
following have named owners and evidence:

- approved privacy notice, processing purpose/legal basis, data inventory,
  retention/deletion schedule, data-subject handling, incident response, and
  subprocessor/DPA review;
- confirmed region and cross-border-transfer position for each provider (GCS
  location must not be used as evidence for Gemini, Resend, or OAuth);
- least-privilege runtime identity, secrets in Secret Manager, rotation and
  revocation runbooks, and no secrets in source, images, logs, or support data;
- bounded timeouts, explicit retry/idempotency rules, quota/spend/backlog alerts,
  provider-outage behavior, and restore/reconciliation drills;
- log redaction tests covering authorization, cookies, OAuth codes/tokens,
  reset links, API keys, document bodies/Base64, signed URLs, OCR content, and
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
- Google OAuth: [`oauth.ts`](../artifacts/api-server/src/routes/oauth.ts),
  [`auth.ts`](../artifacts/api-server/src/lib/auth.ts), and
  [`users.ts`](../lib/db/src/schema/users.ts).
- Safe configuration defaults: [`.env.example`](../.env.example) and
  [`GOOGLE_CLOUD_DEPLOYMENT.md`](./GOOGLE_CLOUD_DEPLOYMENT.md).
