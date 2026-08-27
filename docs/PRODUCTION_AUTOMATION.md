# Production release automation

The repository includes two different kinds of automation. Neither sends
credential document bytes to GitHub Actions or to a workflow provider.

## Application events and n8n

The API's durable automation outbox is the supported integration point for
events such as credential creation, verification changes, and expiry work.
Keep the integration disabled until the receiving endpoint and its data
processing terms have been approved. Event payloads must contain only the
minimum tenant-scoped identifiers and state required by the workflow; never
include a document body, signed object URL, password/reset token, TOTP secret,
OCR Base64, or provider credential.

For sensitive production use, prefer an organization-controlled n8n instance
in an approved region and private network. The receiver must verify the HMAC
signature and timestamp before processing, reject replays, use the event ID as
an idempotency key, and return a non-2xx status on failure so the API can apply
bounded retries. Treat a public hosted workflow service as a new subprocessor
that needs privacy, retention, residency, incident, and deletion approval.

An inactive, fail-closed n8n receipt workflow, dedicated inbox SQL, safe
environment example, and offline verifier are available in
[`docs/automation`](./automation/README.md). Importing that template does not
enable the application outbox or deliver an event to an external provider.

## GitHub Actions production deployment

`.github/workflows/deploy-production.yml` is a manual-only release workflow.
It runs only from `main`, requires the operator to type `DEPLOY`, uses a GitHub
`production` environment, authenticates with short-lived Workload Identity
Federation credentials, builds an image tagged with the Git commit, executes
the migration job, updates Cloud Run, and checks `/api/readyz`.

Complete the first provisioning with `infra/gcp/bootstrap.sh`, then configure
these GitHub environment variables (not repository secrets containing JSON):

- `GCP_PROJECT_ID`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCP_BUILD_SOURCE_BUCKET`
- optional `GCP_REGION`, `GCP_SERVICE`, `GCP_ARTIFACT_REPOSITORY`, and
  `GCP_BUILD_SERVICE_ACCOUNT`
- optional `PUBLIC_APP_URL` to verify the production domain after deployment
  instead of only the generated Cloud Run URL

Configure the `production` environment with required reviewers. Restrict the
Workload Identity provider to this repository and `refs/heads/main`. The deploy
identity needs only the ability to submit a build, write the private build
source bucket, act as the dedicated build/runtime identities, and update/execute
the named Cloud Run service and migration job. Do not create or upload a JSON
service-account key.

This workflow intentionally does not create infrastructure, buy a domain,
seed accounts, enable OCR/email, or change stored secrets. Those are separate,
audited operator actions.
