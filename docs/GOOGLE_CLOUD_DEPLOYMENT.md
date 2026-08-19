# Google Cloud deployment (Saudi Arabia)

This is the supported production path for Health Credential Hub. It does not
use Replit. The web application and API run together on Cloud Run, PostgreSQL
data is held in Cloud SQL, and credential documents are held in a private Cloud
Storage bucket. All three resources should use `me-central2` (Dammam).

## Before provisioning

1. Use a Google Cloud project purchased through CNTXT when the billing address
   is in Saudi Arabia. Enable billing for that project.
2. Keep the initial release limited to synthetic data until the organization
   approves its privacy notice, retention schedule, access roles, incident
   process, and any OCR/email subprocessors.
3. Decide who owns the production domain. A generated `run.app` HTTPS domain is
   created first and is sufficient for a controlled acceptance test.

## First deployment

Open Google Cloud Shell, clone this repository at the reviewed commit, and run:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
bash infra/gcp/bootstrap.sh
```

The script provisions a regional PostgreSQL instance with backups and
point-in-time recovery, a private versioned bucket with seven-day soft delete,
Secret Manager values with user-managed replicas in Dammam, a least-privilege
runtime service account, and a separate least-privilege Cloud Build account.
Build source archives use a private regional bucket with seven-day automatic
deletion; build logs go to Cloud Logging. The script also creates an Artifact
Registry repository, a migration job, and a one-instance Cloud Run service. It
finishes by calling `/api/readyz` and prints the generated HTTPS URL. It does
not seed Demo accounts.

The authenticated `gcloud` principal must be allowed to enable services,
manage the listed IAM bindings, create the resources, submit Cloud Builds, and
act as the dedicated build account. The script grants only that current
principal `Service Account User` on the build account; it never relies on the
project's changing default Cloud Build identity.

Run the script from the repository root. Review expected Cloud SQL and Cloud
Run charges before accepting the provider's creation prompts.

## Existing installation upgrade

Migration `0003_fuzzy_scarlet_witch.sql` adds credential row-version locking,
a partial unique index for active file links, and a fail-closed 2FA invariant.
Before applying it to an existing database, both queries below must return no
rows. Investigate and resolve any result through the approved audit/recovery
process; do not delete or rewrite credential history merely to make the
migration pass.

```sql
SELECT file_url, count(*)
FROM credentials
WHERE deleted_at IS NULL AND file_url IS NOT NULL
GROUP BY file_url
HAVING count(*) > 1;

SELECT id
FROM users
WHERE totp_enabled = true AND totp_secret IS NULL;
```

## Custom domain

For production, put a global external HTTPS Application Load Balancer with a
serverless NEG in front of the Dammam Cloud Run service. Use a reserved global
IP, Google-managed certificate, TLS 1.2+, and point the domain's DNS record to
that IP. Update these values after the certificate is active:

- Cloud Run: `PUBLIC_APP_URL=https://your-domain` and
  `APP_ORIGINS=https://your-domain`.
- Cloud Storage bucket CORS: allow `PUT` from exactly that HTTPS origin.
- Google OAuth, if enabled: add
  `https://your-domain/api/auth/google/callback` as an authorized redirect URI.
- Resend, if enabled: verify the sending domain, store `RESEND_API_KEY` in
  Secret Manager, set `EMAIL_FROM`, then change `EMAIL_ALERTS_DISABLED=0`.

Do not use Cloud Run's preview domain-mapping feature for a production domain;
use the load balancer so the certificate and TLS policy are production-grade.

## Release verification

- `GET /api/healthz` returns `200`.
- `GET /api/readyz` returns `200` and confirms database/storage configuration.
- Login without the required request marker is rejected with `403`.
- The bucket has public access prevention and no object is publicly readable.
- An employee can upload a permitted PDF/image and read only their own file.
- Another employee receives `403` for that file path.
- A manager can only read files linked to employees inside their server-side
  scope.
- Database backup/PITR and bucket soft-delete restoration are tested in a
  non-production project.

## Scaling constraint

The first release is intentionally capped at one Cloud Run instance because
login/OCR throttles and 2FA challenge attempt state are currently in memory.
Before raising `--max`, move those controls to a shared Redis or PostgreSQL
store and add multi-instance concurrency tests.
