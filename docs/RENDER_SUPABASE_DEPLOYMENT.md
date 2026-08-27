# Render + Supabase deployment

This runbook deploys the production-code responsive web application and API as
one Docker web service on Render, backed by a persistent Supabase PostgreSQL
database and a private Supabase Storage bucket. It does not enable public
registration, test login, seed data, OCR, email, or automation. "Production
code" means the release has no Demo bypasses; it does not mean this free hosting
profile is production-ready or approved for health data.

## Release status

The checked-in [`render.yaml`](../render.yaml) is the no-card external
**controlled-acceptance** profile. It uses Render Free in Frankfurt and expects
an existing Supabase Free project in Frankfurt. The application and data are
external to the operator's PC, but this profile is not approval for regulated
health-document production:

- Render Free can sleep or suspend and has no production SLA.
- Supabase Free has no production SLA or guaranteed point-in-time backups.
- Frankfurt is outside Saudi Arabia. A documented PDPL transfer assessment,
  provider agreements, retention schedule, and incident process are required
  before real workforce or health data is entered.
- The object-ingress malware/quarantine release gate in
  [`INTEGRATIONS.md`](INTEGRATIONS.md) must be closed before real documents are
  accepted.

The Blueprint explicitly sets `DOCUMENT_UPLOADS_ENABLED=false`. Authentication,
employee records, the dashboard, and scoped administrative workflows can use
the persistent database, while every document-upload attempt is rejected
fail-closed and no file is created. In this controlled-acceptance mode,
`/api/readyz` verifies the dependencies required by that mode without pretending
a scanner exists. When document intake is later enabled, readiness must also
prove the approved Linux scanner is available, and a clean end-to-end upload
must pass before the change is released.

Do not weaken a failing readiness or database-role check to make this profile
start. A `503` from `/api/readyz` is a release blocker, not a warning.

## Runtime layout

```text
mobile/desktop browser
        |
        | HTTPS, same origin
        v
Render Docker web service (React + Express)
        |                         |
        | TLS PostgreSQL          | HTTPS S3 API, server-only keys
        v                         v
Supabase session pooler      private Supabase Storage bucket
```

The Docker build runs the repository's real `build:production` script. The
container starts the real API `start` output with the Dockerfile's command:

```text
node --enable-source-maps dist/index.mjs
```

Render probes `GET /api/readyz`. That endpoint verifies the dependencies needed
for the configured mode. With document intake enabled this includes PostgreSQL,
private storage, and the server-mediated scanner; `GET /api/healthz` is only
process liveness.

## 1. Prepare Supabase

Use the existing project in `eu-central-1` (Frankfurt):

1. Keep the Data API disabled. The application uses PostgreSQL directly.
2. Enable SSL enforcement for database connections.
3. Create one private Storage bucket. Set an 8 MB file limit and allow only
   `application/pdf`, `image/jpeg`, and `image/png`.
4. Create an S3 access-key pair for the private bucket. Store it only in the
   Render secret environment. Supabase S3 access keys bypass Storage RLS and
   must never be placed in browser code, Git, screenshots, CI output, or chat.
5. Record the S3 endpoint in this form:
   `https://PROJECT_REF.storage.supabase.co/storage/v1/s3`.
6. Use the session-pooler connection on port `5432` with
   `sslmode=verify-full`. The image loads Supabase's published production CA
   through `NODE_EXTRA_CA_CERTS`; hostname and certificate verification must
   remain enabled. Do not use the transaction pooler on port `6543` for
   migrations because migrations use session-scoped advisory locks.

### Required database identities

The release requires four distinct PostgreSQL roles:

| Purpose                | Required name             | Login |
| ---------------------- | ------------------------- | ----- |
| API login              | `healthdocs_app`          | yes   |
| API DML boundary       | `healthdocs_app_dml`      | no    |
| migration login        | `healthdocs_migrator`     | yes   |
| migration DDL boundary | `healthdocs_migrator_ddl` | no    |

Provision the roles from an approved administrator session, with separate
generated passwords for the two login roles. Never paste passwords into the
Supabase SQL editor, committed SQL, terminal history, screenshots, or chat.
Use the repository's guarded `provision:managed` command described below. It
creates the four roles once and refuses to overwrite existing credentials.

The managed-provider boundary keeps the Supabase-owned database and `public`
schema intact. The migration login receives only `CONNECT` and `CREATE` on the
database plus `USAGE` and `CREATE` on `public`; the runtime login owns no objects
and has only the DML boundary role. Supabase's `anon`, `authenticated`, and
`service_role` roles are declared in `DATABASE_BLOCKED_ROLES` and retain no
application table, sequence, or function privileges. The migration login itself
must not have `CREATEROLE`.

The migration command below establishes and verifies the remaining grants. If
Supabase prevents the required ownership boundary, stop: do not use the project
owner URL for the long-running API and do not set
`VERIFY_DATABASE_ROLE_BOUNDARY=false`.

## 2. Provision managed roles, then migrate

Install and verify the exact lockfile first:

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build:production
docker build --pull --tag wathaiqi-health:release .
```

From a trusted workstation, open a shell whose environment is populated by the
approved secret manager. Do not put these values in the repository `.env`.
Provide the Supabase project-owner connection only for this one-time command:

```dotenv
NODE_EXTRA_CA_CERTS=/absolute/path/to/config/supabase-prod-ca-2021.crt
DATABASE_URL=postgresql://PROJECT_OWNER_POOLER_USER:REDACTED@SESSION_POOLER_HOST:5432/postgres?sslmode=verify-full
APP_DATABASE_USER=healthdocs_app
APP_DATABASE_ROLE=healthdocs_app_dml
MIGRATOR_DATABASE_USER=healthdocs_migrator
MIGRATOR_DATABASE_ROLE=healthdocs_migrator_ddl
APP_DATABASE_PASSWORD=REDACTED_GENERATED_PASSWORD
MIGRATOR_DATABASE_PASSWORD=REDACTED_DIFFERENT_GENERATED_PASSWORD
```

Run the repository's real one-shot provisioner:

```bash
pnpm --filter @workspace/db run provision:managed
```

Success prints
`Managed PostgreSQL roles provisioned with isolated application and migration privileges.`
The command rolls back and refuses to continue if any of its four role names
already exists. Remove the project-owner URL and both plaintext password values
from the process environment immediately; retain the two generated passwords
only in the approved password manager.

Create a temporary migration environment file **outside this repository** with
restricted filesystem permissions. It contains only:

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://MIGRATOR_POOLER_USER:REDACTED@SESSION_POOLER_HOST:5432/postgres?sslmode=verify-full
APP_DATABASE_USER=healthdocs_app
APP_DATABASE_ROLE=healthdocs_app_dml
MIGRATOR_DATABASE_USER=healthdocs_migrator
MIGRATOR_DATABASE_ROLE=healthdocs_migrator_ddl
VERIFY_DATABASE_ROLE_BOUNDARY=true
DATABASE_OWNERSHIP_MODE=managed
DATABASE_BLOCKED_ROLES=anon,authenticated,service_role
MIGRATIONS_DIR=/app/migrations
```

Run the bundled migration entry point. This is not `push` or `push-force`:

```bash
docker run --rm --env-file /secure/path/wathaiqi-migration.env \
  --entrypoint node wathaiqi-health:release dist/migrate.mjs
```

Success prints `Database migrations applied successfully.` A failure must leave
the current Render revision in place. Remove the temporary environment file
from the workstation after the release and retain the migration password only
in the approved password manager.

Render Free does not provide an isolated pre-deploy command. That is why
`render.yaml` sets `autoDeployTrigger: off`: every database migration completes
before the operator manually deploys the matching commit.

## 3. Create the first administrator once

Do this only after migrations succeed and only when no administrator exists.
Create a second temporary environment file outside the repository using the
least-privilege **application** connection, not the migration connection:

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://APP_POOLER_USER:REDACTED@SESSION_POOLER_HOST:5432/postgres?sslmode=verify-full
BOOTSTRAP_CONFIRM=CREATE_FIRST_ADMIN
BOOTSTRAP_ADMIN_EMAIL=admin@example.invalid
BOOTSTRAP_ADMIN_PASSWORD=REDACTED_ONE_TIME_PASSWORD
BOOTSTRAP_ADMIN_NAME=Administrator
BOOTSTRAP_ADMIN_NAME_AR=مدير النظام
BOOTSTRAP_ADMIN_EMPLOYEE_NUMBER=ADMIN-001
BOOTSTRAP_ADMIN_ROLE=system_admin
BOOTSTRAP_CREATE_FACILITY=CREATE_FACILITY
BOOTSTRAP_FACILITY_NAME=Wathaiqi Health
BOOTSTRAP_FACILITY_NAME_AR=وثائقي الصحية
```

Run the guarded one-shot entry point:

```bash
docker run --rm --env-file /secure/path/wathaiqi-bootstrap.env \
  --entrypoint node wathaiqi-health:release dist/bootstrap-admin.mjs
```

The command refuses to create another administrator once one exists. Delete
the temporary file immediately, sign in once, change the temporary password,
enroll TOTP, store recovery codes in the approved password manager, and then
confirm the temporary password is no longer retained anywhere.

Never add `BOOTSTRAP_*` variables to the Render web service.

## 4. Create the Render Blueprint

In Render, create a Blueprint from the repository root and branch `main`.
Render builds [`Dockerfile`](../Dockerfile); there is no separate invented
build or start command. Provide these prompted secret values:

If the Render workspace is not connected to GitHub, create a **Web Service**
from the public Git repository
`https://github.com/itzzkemo-cyber/Health-Credential-Hub.git` instead. Select
Docker, branch `main`, Frankfurt, and the Free plan; leave Dockerfile as
`./Dockerfile`, build context as `.`, Docker command empty, health-check path as
`/api/readyz`, and automatic deploys off. Then copy the non-secret values and
secret prompts from `render.yaml` into the service environment. This produces
the same runtime without granting Render write access to GitHub.

| Render variable                       | Value                                                          |
| ------------------------------------- | -------------------------------------------------------------- |
| `DATABASE_URL`                        | application-role session-pooler URL with `sslmode=verify-full` |
| `PUBLIC_APP_URL`                      | exact Render HTTPS URL for the first launch                    |
| `PRIVATE_OBJECT_DIR`                  | `/PRIVATE_BUCKET_NAME/private`                                 |
| `S3_OBJECT_STORAGE_ENDPOINT`          | Supabase project S3 endpoint                                   |
| `S3_OBJECT_STORAGE_ACCESS_KEY_ID`     | server-only S3 access key                                      |
| `S3_OBJECT_STORAGE_SECRET_ACCESS_KEY` | server-only S3 secret key                                      |

The non-secret runtime boundary must remain exactly:

```dotenv
NODE_EXTRA_CA_CERTS=/app/certs/supabase-prod-ca-2021.crt
DATABASE_OWNERSHIP_MODE=managed
DATABASE_BLOCKED_ROLES=anon,authenticated,service_role
DOCUMENT_UPLOADS_ENABLED=false
```

The Blueprint generates independent 256-bit `SESSION_SECRET` and
`TOTP_ENCRYPTION_KEY` values. Preserve those values across redeploys; rotating
the first invalidates sessions and rotating the second requires a controlled
TOTP migration.

Do not place the migration URL, project-owner URL, database passwords,
bootstrap values, service-role keys, or document data in the Blueprint.

After CI, migration, and bootstrap gates pass, trigger the Render deploy
manually. The release is healthy only when Render reports the health check as
passing and both commands return `2xx`:

```bash
curl --fail --show-error https://YOUR_SERVICE.onrender.com/api/healthz
curl --fail --show-error https://YOUR_SERVICE.onrender.com/api/readyz
```

## 5. Acceptance checks

Use a disposable empty facility and non-sensitive files only until every
production gate in the first section is accepted.

At a 390 px viewport, check both Arabic RTL and English LTR:

1. Sign in with the changed administrator password and TOTP.
2. Create a scoped manager and a scoped employee through authenticated admin
   workflows; confirm there is no public sign-up path.
3. Confirm document controls show intake as unavailable, a direct upload attempt
   is rejected fail-closed, and no object is created. After an approved Linux
   scanner is configured in a later release, set `DOCUMENT_UPLOADS_ENABLED=true`,
   require `/api/readyz` to pass, then upload an allowed file, inspect its status,
   and delete it when authorized.
4. As the manager, confirm only employees and documents in the assigned
   facility are visible.
5. Confirm an employee cannot verify their own credential or change facility.
6. Sign out and verify authenticated API routes reject the old session.

Do not use browser request interception, synthetic runtime data, or a test-only
login to make these checks pass.

## 6. Custom domain and operations

Keep the Render `onrender.com` address until acceptance passes. Then add
`app.wathaiqihealth.com` in Render, publish the exact DNS records Render shows,
wait for certificate issuance, and update `PUBLIC_APP_URL` to
`https://app.wathaiqihealth.com`. Same-origin CSRF checks do not require a CORS
exception; add `APP_ORIGINS` only for a separately approved HTTPS frontend.

Before real use, complete all of the following:

- a paid production service with availability commitments and no idle sleep;
- automated encrypted database and object backups plus a tested restore drill;
- malware quarantine/scanning and orphan-object cleanup;
- PDPL transfer, provider-contract, retention, and breach-response approval;
- rate limiting, monitoring, alerting, and audit-log retention;
- storage-key, session-secret, TOTP-key, and database-credential rotation
  runbooks.

If a storage key is exposed, disable it in Supabase immediately, create a new
key, update Render, deploy, and review storage access/audit evidence. If an
application database password is exposed, rotate only that login and update
Render; never substitute the project-owner connection.

## Provider references

- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render Free limitations](https://render.com/docs/free)
- [Supabase PostgreSQL connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase PostgreSQL SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Supabase S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility)
- [Supabase regions](https://supabase.com/docs/guides/platform/regions)
