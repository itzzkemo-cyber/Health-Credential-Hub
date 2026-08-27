# Safe n8n receiver package

This directory contains an **inactive, importable n8n receiver** for the
Health Credential Hub automation webhook. It is a staging package, not an
enabled production integration. Importing it does not change the application,
Render, Supabase, or the outbox feature flags.

## What it is useful for

The receiver gives the workflow layer a small, durable security boundary:

- it verifies the HMAC over the timestamp and the exact raw request body;
- it rejects requests more than five minutes old;
- it validates the minimized event contract and an explicit facility list;
- it records the event UUID atomically, so a retry cannot be accepted twice;
- it stores only event ID, facility ID, event type, and timestamps;
- it does not store or forward employee/credential IDs, document content,
  object URLs, OCR results, contact data, credentials, or authentication data.

ببساطة: فائدته أن أحداث انتهاء أو اعتماد الوثائق تصل إلى طبقة الأتمتة بشكل
موثوق وآمن، من دون إرسال الملف نفسه أو بيانات الموظف إلى مزود خارجي. الحزمة
لا تشغّل رسائل أو مهام خارجية حتى يعتمد المشغل الاستضافة والمنطقة والاحتفاظ.

## Files

- `wathaiqi-n8n-receiver.workflow.json`: inactive n8n workflow import.
- `n8n-inbox.sql`: dedicated receipt table and least-privilege database role.
- `n8n.env.example`: privacy-oriented self-hosted n8n settings with no secrets.
- `verify-package.mjs`: offline structural and security-contract checks.

## Mandatory deployment boundary

Use a self-hosted n8n instance and PostgreSQL database controlled by the
operator in an approved region. Do not reuse the Health Credential Hub
application database or its database user. The n8n ingress must use HTTPS.
Review n8n version changes before upgrading; pin and test a supported n8n 2.x
release before production.

Keep all of these application values disabled while preparing the receiver:

```dotenv
AUTOMATION_OUTBOX_ENABLED=false
AUTOMATION_WEBHOOK_ENABLED=false
```

Enabling an external processor requires explicit approval of its purpose,
region, DPA/subprocessors, retention/deletion, access controls, incident
handling, and facility list. This package intentionally does not deploy n8n,
activate the imported workflow, or change production environment variables.

## Installation sequence

1. Before importing or editing anything, run the offline checks against the
   untouched repository package:

   ```powershell
   node .\docs\automation\verify-package.mjs
   ```

   The verifier intentionally expects an inactive workflow, an empty facility
   allowlist, and no embedded credentials. Stop if it fails; do not edit the
   package to make it pass.

2. Provision a dedicated n8n PostgreSQL database and run `n8n-inbox.sql` as its
   owner. Create a separate login and grant it membership in
   `wathaiqi_n8n_inbox_writer`; do not give it application database access.
3. Configure the n8n service from `n8n.env.example`. Generate a stable
   `N8N_ENCRYPTION_KEY` in a password manager and back it up securely.
4. Generate one high-entropy printable receiver secret. Enter the printable
   value only in an n8n **Crypto** credential as `Hmac Secret`.
5. The worker expects canonical Base64 bytes. If the n8n HMAC secret is the
   printable string `receiverSecret`, set the worker secret to
   `Base64(UTF8(receiverSecret))`, not to `receiverSecret` directly. For
   example, on an isolated administrator workstation:

   ```powershell
   $randomBytes = [byte[]]::new(32)
   [Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
   $receiverSecret = [Convert]::ToBase64String($randomBytes)
   $workerSecret = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($receiverSecret))
   ```

   Store `$receiverSecret` in the n8n Crypto credential and `$workerSecret` in
   the worker's secret manager. Do not paste either value into Git, workflow
   JSON, logs, tickets, chat, or screenshots.

6. Import `wathaiqi-n8n-receiver.workflow.json`. Attach the Crypto credential
   to `Compute expected HMAC` and the dedicated PostgreSQL credential to
   `Claim event ID atomically`.
7. In `Validate raw request`, replace the empty
   `ALLOWED_FACILITY_IDS` array with the exact reviewed positive facility IDs.
   It must match the worker's `AUTOMATION_FACILITY_ALLOWLIST`. An empty list
   fails closed with HTTP 503.
8. In a non-production environment, publish the workflow and test a synthetic
   signed event. Confirm valid=202, duplicate=200, invalid signature=401,
   stale timestamp=401, unlisted facility=403, and database failure=5xx.
9. Review the n8n execution-retention configuration and verify that successful,
   failed, and manual execution bodies are not retained. Run `n8n audit` and
   restrict workflow/credential editors.
10. Only after explicit approval, set the worker URL/host allowlist and secret,
    then enable the outbox and webhook switches for the reviewed facilities.

## Idempotency and downstream actions

The imported workflow is intentionally only an authenticated receipt endpoint.
It returns 202 after the receipt row is inserted, or 200 if the event ID already
exists. A lost HTTP response can therefore be retried safely.

Do not attach email, chat, HTTP Request, AI, document, or storage nodes directly
to this receiver. Build a separate, reviewed dispatcher that claims pending
receipt IDs with its own status/lease and provider idempotency key. If that
dispatcher needs more business context, call a narrowly scoped internal API
after authorization; never expand this webhook to carry document or employee
details.

## Rotation

The current sender supports one HMAC secret. Rotation therefore requires a
planned maintenance window or a reviewed dual-key receiver extension: pause
delivery, update the n8n Crypto credential and worker secret together, send a
synthetic event, then resume. Never delete inbox receipts during rotation.
