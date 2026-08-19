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

Open Google Cloud Shell, clone this repository at the reviewed commit, and run
the read-only preflight before provisioning:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
bash infra/gcp/preflight.sh
bash infra/gcp/bootstrap.sh
```

The preflight verifies an active CLI account, project visibility/lifecycle,
billing, and the fixed Dammam region without enabling an API or creating a
resource. It intentionally does not print the active user or billing-account
identifier. If it cannot read billing metadata, have a project/billing
administrator perform this check instead of bypassing it.

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

The first run also provisions or updates a disabled-by-default one-shot
`health-credential-hub-automation` Cloud Run Job. It uses a dedicated service
account with Cloud SQL and its own regional HMAC secret, but no GCS, session,
or TOTP-secret access. A separate scheduler identity receives Job-level
`roles/run.invoker` only; its five-minute `me-central2` schedule is created
paused and remains paused unless automation is explicitly enabled. The
bootstrap does not create a webhook receiver. See
[`INTEGRATIONS.md`](./INTEGRATIONS.md) before enabling it.

## Create the first production administrator

The migration job creates schema only. A new database intentionally has no
default user or password. The bootstrap provisions an inert
`health-credential-hub-bootstrap-admin` Cloud Run Job under a dedicated
identity with only Cloud SQL and `DATABASE_URL` access. Missing confirmation
and password values make an accidental execution fail before a write. For local
operator testing, the equivalent package command is:

```bash
pnpm --filter @workspace/api-server run bootstrap:admin
```

Inject these values into the one-shot job; do not put the password on a shell
command line, in source, in an image layer, or in a committed `.env` file:

- `BOOTSTRAP_CONFIRM=CREATE_FIRST_ADMIN`
- `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (16+ characters with
  upper/lower/number/symbol), `BOOTSTRAP_ADMIN_NAME`,
  `BOOTSTRAP_ADMIN_NAME_AR`, `BOOTSTRAP_ADMIN_EMPLOYEE_NUMBER`
- `BOOTSTRAP_ADMIN_ROLE=hospital_admin` or `system_admin` (no default)
- either `BOOTSTRAP_FACILITY_ID=<reviewed existing id>`, or for a completely
  empty database the additional explicit
  `BOOTSTRAP_CREATE_FACILITY=CREATE_FACILITY` plus
  `BOOTSTRAP_FACILITY_NAME` and `BOOTSTRAP_FACILITY_NAME_AR`

Store the password as a short-lived Secret Manager version mounted only into
this job. Create it from standard input so it does not enter shell history,
grant only the bootstrap identity access, update the Job with the non-secret
values above, and execute it once. Destroy or disable the password secret
version and delete the temporary Job immediately after a successful run.
The command deletes the password from its process environment after reading
it, never prints it, serializes concurrent runs with a PostgreSQL advisory
lock, and creates the facility/account/audit event in one transaction.

The command refuses to change anything if any hospital/system administrator
already exists, if the email already belongs to a user, or if the selected
facility is absent. It has no reset/update mode. Subsequent administrator
creation and account recovery must use the authenticated application workflow
and approved audit process.

There is currently no database-enforced `mustChangePassword` or
`mustEnrollMfa` flag. Consequently, production launch must remain blocked from
loading real workforce data until two operators verify that the first
administrator has signed in, changed the one-time bootstrap password, enrolled
TOTP, stored recovery codes in the approved password manager, and that the
temporary password secret and Job were removed. This is an explicit operator
gate, not a control the application can presently prove automatically.

## Migration database identity

The bootstrap now gives the migration Job its own Google service account,
separate from the public API, worker, scheduler, and first-admin identities.
The current bootstrap still mounts the same PostgreSQL `DATABASE_URL`, so Cloud
IAM isolation is implemented but database-principal least privilege is not yet
automatic. Before production, create a separate PostgreSQL login/Secret Manager
URL for the migrator, grant it schema ownership/DDL only, revoke schema creation
from the application login, and grant the application login only the required
DML and sequence rights. A reviewed starting policy is:

```sql
GRANT CONNECT ON DATABASE healthdocs TO healthdocs_migrator, healthdocs_app;
GRANT USAGE, CREATE ON SCHEMA public TO healthdocs_migrator;
REVOKE CREATE ON SCHEMA public FROM healthdocs_app;
GRANT USAGE ON SCHEMA public TO healthdocs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO healthdocs_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO healthdocs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE healthdocs_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO healthdocs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE healthdocs_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO healthdocs_app;
```

Create the logins and passwords through the approved Cloud SQL/Secret Manager
procedure; do not paste passwords into SQL files or shell history. Point only
the migration Job at the migrator URL and test migrate plus API startup before
revoking the shared role. Until completed, PostgreSQL role separation remains
a production launch blocker.

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

Migration `0005_automation_outbox.sql` adds the optional minimized workflow
outbox and a minimal permanent terminal delivery/discard ledger. It does not
send external traffic. Both event production and the separate webhook worker
remain disabled until their explicit environment switches are enabled; see
[`INTEGRATIONS.md`](./INTEGRATIONS.md).

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

After the load balancer, certificate, DNS, CORS, and custom-domain readiness
check all succeed, prevent clients from bypassing the load balancer:

```bash
gcloud run services update "health-credential-hub" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="me-central2" \
  --ingress="internal-and-cloud-load-balancing" \
  --no-default-url
```

Run this only after the custom-domain smoke test succeeds; otherwise it removes
the generated `run.app` acceptance URL. Keep the service's application-level
authentication and tenant authorization in place—the load balancer is an
additional network boundary, not a replacement.

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
