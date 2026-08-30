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

For the operator-approved monitor `803870616` created on 2026-08-31, observed
free-plan defaults are five-minute checks, 2xx/3xx success policy, no delay or
repeat, redirect following OFF, and business-email alerts. The first check was
Up; built-in DOWN/UP test emails reached the operations inbox without service
interruption. Exact HTTP-200-only success codes and custom methods were paid
features, so the stricter target policy above is not claimed configured. See
[`MONITORING_AND_STORAGE.md`](MONITORING_AND_STORAGE.md) for dated evidence.

## 3. Encrypted backup implementation

Use [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) and
[`scripts/operations/backup.mjs`](../scripts/operations/backup.mjs). The approved
runner streams PostgreSQL and private documents into AES-256-GCM ciphertext,
encrypts checksums and ACL custom metadata in its manifest, rejects changed
inventories and incomplete captures, then verifies the completed archive. It
requires a real write freeze and separate backup-only credentials; there is no
automatic production freeze or scheduling in this repository.

```bash
node scripts/operations/backup.mjs backup
node scripts/operations/backup.mjs verify
```

Before invoking these commands, approve the exact source, source privacy,
off-provider encrypted destination, region, retention, independent key escrow,
RPO/RTO, PostgreSQL tool versions and operator/reviewer. Supply the documented
environment out of band, never through the application `.env` or command-line
passwords. Do not retain a failed capture as a recovery point. Monitor failure,
age of latest verified backup, quota and expiry; test actual alert delivery.

Do not use the previous plain `pg_dump` + `s3 sync` template: it did not preserve
the application's private ACL custom metadata or provide an authenticated
encrypted manifest. Native PITR/versioning may complement this control, but do
not replace an independently verified recovery.

## 4. Isolated restore verification

```bash
node scripts/operations/backup.mjs restore-local
```

This command authenticates every entry **before** creating an extraction tree
or contacting PostgreSQL; it requires a new restricted encrypted destination
and a new empty `hch_restore_*` database on numeric loopback. It refuses target
overwrites and restores in one PostgreSQL transaction. It writes no cloud
objects. The documented extraction format preserves bytes, content type and
private ACL metadata for a separately approved recovery adapter.

On 2026-08-31 the real local PostgreSQL drill passed: 10 SQL migrations, 13
tables, two synthetic facilities/employees/credential records and two synthetic
local document payloads. Data/checksums/ACL metadata matched; corrupted input
was rejected before restoration and an existing database could not be
overwritten. See the detailed evidence and repeatable tests in
[`BACKUP_RESTORE.md`](BACKUP_RESTORE.md).

**This is not a live Supabase backup or cloud recovery sign-off.** Before real
workforce data, take an approved live capture and restore it to an isolated
approved environment. Reapply reviewed database role/grant boundaries, recover
the original TOTP key through independent escrow (or a reviewed reenrollment),
rotate session secrets, and keep outbound integrations disabled. Verify
readiness, administrator/employee authorization, anonymous/cross-facility file
denial, counts and checksums. Record measured recovery point/duration and
reviewer, then separately approve credential revocation and cleanup.

Backup readiness remains blocked until the operator's source, destination,
schedule, alert delivery, retention, key recovery and real-provider drill have
current evidence, even when `/api/readyz` and local tests pass.
