# Production operations evidence runbook

This runbook turns release identity, availability monitoring, backup, and
restore verification into repeatable operator steps. It does **not** provision
or prove an external control. Render Free and Supabase Free remain a controlled
acceptance environment, not approved healthcare production. Do not introduce
real workforce documents until the PDPL, provider, retention, incident, paid
availability, backup, and restore gates in
[`RENDER_SUPABASE_DEPLOYMENT.md`](RENDER_SUPABASE_DEPLOYMENT.md) are closed.

## 1. Verify the running release

`GET /api/healthz` and `GET /api/readyz` expose only a validated lowercase Git
SHA (`7` to `40` hexadecimal characters) as `releaseSha`. On Render the runtime
provided `RENDER_GIT_COMMIT` is authoritative. Other approved deployments may
set `RELEASE_SHA` to the exact deployed commit. Missing or malformed values are
omitted rather than echoed.

After CI and the reviewed migration complete, deploy manually and run from the
exact clean checkout being released:

```bash
export EXPECTED_SHA="$(git rev-parse HEAD)"
export READY_URL="https://app.wathaiqihealth.com/api/readyz"
node -e '(async()=>{const r=await fetch(process.env.READY_URL,{headers:{"cache-control":"no-cache"}}); const b=await r.json(); if(!r.ok||b.status!=="ready"||b.database!=="ok"||b.objectStorage!=="verified"||b.releaseSha!==process.env.EXPECTED_SHA){throw new Error("Live release verification failed")} console.log(`Verified ${b.releaseSha}`)})().catch(()=>process.exit(1))'
```

Do not sign off when the SHA is absent or different. Do not set a static
`RELEASE_SHA` on Render to conceal a mismatch. Preserve the expected and
observed SHA, UTC timestamp, CI URL, migration result, and operator identity in
the release ticket. A successful readiness probe is not an authorization or
data-integrity test.

## 2. Configure and operate availability monitoring

Create one HTTPS monitor for
`https://app.wathaiqihealth.com/api/readyz` with a five-minute interval:

- require HTTP `200`; alert after two consecutive failures and on recovery;
- send alerts only to the approved operations channel and at least two named
  operators; never put credentials, document paths, query parameters, employee
  identifiers, or response bodies in the monitor;
- record monitor owner, alert recipients, escalation time, provider, and the
  date of the last alert-delivery test;
- test alert delivery in an approved maintenance window, then restore the
  service and retain both failure and recovery evidence;
- review weekly: readiness availability, Render restarts/deploys, Supabase
  database/storage capacity, failed sign-ins, audit anomalies, email failures,
  and pending/dead-letter automation events when those features are enabled.

The monitor proves only that the configured database, private storage, upload
processor, and opted-in providers passed readiness. Keep a separate incident
procedure for authorization failures, suspected disclosure, credential
rotation, and provider outage. The repository does not configure UptimeRobot or
an alert destination automatically.

## 3. Backup prerequisites and evidence

Before real data, move to plans with explicit availability and backup terms.
Assign a backup operator and an independent restore reviewer. The operator must:

1. Use a dedicated, read-only database backup identity and a dedicated
   server-only object-storage backup identity. Inject both from the approved
   secret manager; never place credentials in shell history, this repository,
   logs, tickets, or backup manifests.
2. Write database dumps and private objects to an encrypted, access-restricted,
   off-provider destination. The destination region, retention, deletion,
   immutability, key ownership, and access logging require approval.
3. Freeze application writes for the consistency window before capturing the
   database and object store. The current Render profile has no repository
   maintenance-mode command, so the exact external traffic-block or suspension
   procedure must be documented and rehearsed before this can be automated.
4. Create a PostgreSQL custom-format dump with `pg_dump` using
   `--format=custom --no-owner --no-acl`, copy the complete private bucket
   through the provider's supported S3 backup tool, then resume writes only
   after both operations succeed. Never use the application or migration
   password as the long-lived backup identity.
5. Generate a manifest containing only backup ID, UTC start/end, release SHA,
   migration version, database dump checksum, object count, aggregate bytes,
   and object-key/checksum pairs. Protect the detailed manifest like document
   data because object keys can be identifying; never attach it to GitHub.
6. Monitor job success, age of the newest usable backup, destination capacity,
   retention expiry, and access anomalies. Alert before the approved recovery
   point objective is exceeded.

After writes are verifiably frozen, an approved isolated backup runner with
PostgreSQL tools and AWS CLI may use this template. Configure the referenced
libpq service and AWS profile from the secret manager outside this repository;
both must be backup-only identities. `BACKUP_DIR`, `S3_ENDPOINT`, and
`PRIVATE_BUCKET` must be pre-reviewed explicit values on encrypted storage.

```bash
set -euo pipefail
umask 077
mkdir -p "${BACKUP_DIR}/objects"
pg_dump --dbname="service=healthdocs-backup" --format=custom --no-owner --no-acl --file="${BACKUP_DIR}/database.dump"
aws --profile healthdocs-backup --endpoint-url "${S3_ENDPOINT}" s3 sync "s3://${PRIVATE_BUCKET}/private/" "${BACKUP_DIR}/objects/" --only-show-errors
sha256sum "${BACKUP_DIR}/database.dump" > "${BACKUP_DIR}/database.dump.sha256"
```

Exit nonzero on any failed command in the scheduled job, never print profile
contents, and move the completed backup plus protected object manifest to the
approved off-provider destination before considering the run successful.

Provider-native database PITR and object versioning or replication are
preferred when approved, but they do not replace an independent restore drill.
Supabase Free has no guaranteed PITR; a dashboard badge or successful `pg_dump`
alone is not backup evidence.

## 4. Disposable restore drill

Run at the agreed cadence and after schema, storage, key, or provider changes:

1. Select a completed backup and verify its manifest and checksums before any
   restore. Record the backup ID and source release SHA, not credentials or
   object names, in the drill ticket.
2. Create an isolated disposable PostgreSQL database and private bucket in the
   approved region. Deny public access and all production runtime identities.
   Never restore over production and never reuse production URLs.
3. Restore the database with `pg_restore --exit-on-error --no-owner --no-acl`
   under a temporary restore identity, then restore objects through the
   provider-supported S3 tool. Recalculate and compare dump/object checksums and
   counts to the protected manifest.
4. Deploy the recorded source commit to an isolated service with new session
   and TOTP keys. Run migrations only if the drill explicitly tests a forward
   upgrade; otherwise the code, schema, and backup must represent the same
   release.
5. Confirm `/api/readyz` returns `200`, reports database/storage readiness, and
   exposes the expected `releaseSha`. Use only approved synthetic accounts and
   documents to test sign-in, scoped read, rebuilt-image download, and
   authorized deletion. Verify cross-facility and anonymous reads fail.
6. Record start/end times, recovery point, recovery duration, checksum/count
   results, test outcomes, deviations, reviewer, and corrective actions. Do not
   put document content, object keys, employee data, passwords, or tokens in the
   evidence.
7. Revoke temporary credentials and destroy the isolated service, database,
   bucket, and copied documents under a reviewed deletion ticket. Preserve only
   the minimized drill evidence for the approved retention period.

Only after confirming the destination is disposable, the restore runner may use
the corresponding restricted profiles:

```bash
set -euo pipefail
sha256sum --check "${BACKUP_DIR}/database.dump.sha256"
pg_restore --dbname="service=healthdocs-restore" --exit-on-error --no-owner --no-acl "${BACKUP_DIR}/database.dump"
aws --profile healthdocs-restore --endpoint-url "${RESTORE_S3_ENDPOINT}" s3 sync "${BACKUP_DIR}/objects/" "s3://${RESTORE_BUCKET}/private/" --only-show-errors
```

These commands do not create a consistent backup by themselves; the write
freeze, protected manifest, object checksum comparison, isolated deployment,
authorization smoke tests, review, and cleanup above remain mandatory.

A backup is not accepted until this drill succeeds within the approved RPO/RTO.
Until there is current evidence, production readiness remains blocked even when
`/api/readyz` is healthy.
