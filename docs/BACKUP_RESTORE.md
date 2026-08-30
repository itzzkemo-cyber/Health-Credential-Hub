# Encrypted backup and isolated restore

## Current status and scope

The repository now includes a runnable backup implementation and tests, not just
shell templates. The production adapter reads PostgreSQL and the existing
Supabase private S3 `private/` prefix. It does not add an external processor,
upload backups to a new provider, or change production configuration.

**No live database/bucket backup has been taken by this change. No production
backup schedule, off-provider destination, key custody, retention policy, or
provider recovery test is claimed.** These remain operator release gates.

On 2026-08-31 a local disposable PostgreSQL 16 drill passed using all 10 current
SQL migrations (13 tables), two synthetic facilities, two synthetic employees,
two synthetic credential records and two synthetic local document payloads.
Database rows, document hashes, content types and private ACL custom metadata
matched after recovery. Reusing a nonempty restore database was rejected.
Corrupting an encrypted object was rejected before creating the extraction tree;
the separate negative-test database remained empty. The test cluster was stopped
and only its newly created fixture directory was removed afterward.

The latest drill's dump was 51,714 bytes. Capture/verification/restore and negative
checks took 1,063 ms; the entire test, including PostgreSQL initialization, took
about 12 seconds. A database containing only an existing function (no tables)
was also rejected as nonempty. These synthetic measurements are **not a
production RPO/RTO**.
The two document payloads test archival bytes, not PDF/image parser validity;
upload-parser tests are separate. This drill does not prove cloud permissions,
real backup coverage, reconnected application login, or provider availability.

## Security and consistency model

- `pg_dump --format=custom --no-owner --no-acl --no-password` streams directly
  into AES-256-GCM ciphertext. No plaintext dump is staged during capture.
- Each document, database dump and manifest has an independent random 96-bit
  nonce and 128-bit authentication tag. Authenticated additional data binds each
  ciphertext to its backup ID and logical object, preventing blob substitution.
- The **encrypted** manifest records source identity hash, release SHA,
  migration tag, UTC timestamps, sizes, SHA-256 checksums, object keys, content
  types and all custom metadata (including `acl-policy` / `content-sha256`).
  Object names and metadata are never printed. Outside it, filenames are random
  UUIDs plus a constant `COMPLETE` marker; object counts/file sizes remain visible
  to anyone who can list the archive, so encrypt/restrict the destination volume
  as well. There is no compression or deduplication.
- The backup-only runner must independently freeze **all** API, worker,
  scheduled and administrator writes before capture. The tool requires the
  explicit acknowledgement below, but cannot perform or verify an external
  freeze itself. It compares full S3 inventories (key/ETag/modified time/size)
  before and after, uses conditional reads, and refuses any observed change.
  This catches common races; it is not a substitute for the freeze.
- Interrupted dumps, missing pages, changed objects, public object ACLs,
  oversized entries and incomplete captures fail closed. A failed run has no
  success output and must not be retained as a usable recovery point.
- No overwrites: backup and extraction require a new leaf directory with an
  existing parent. Relative, wildcard, unresolved, broad and symlink/junction
  paths are rejected. Hard-linked input files are rejected. The runner and
  destination parent must be accessible only to the operator; this is not a
  defense against a compromised same-user account that can race file mutations.
  POSIX modes are `0700`/`0600`; **Windows operators must separately enforce
  NTFS ACLs and BitLocker/encrypted-volume protection**.
- Restore authenticates and hashes **all** entries before creating a plaintext
  destination or invoking PostgreSQL. Extraction repeats authenticated reads,
  then checks restored bytes and custom metadata. A failed extraction must not
  be served by an app; quarantine it pending reviewed cleanup.
- `restore-local` accepts only explicit `127.0.0.1`/`::1` and a
  `hch_restore_*` database, refuses libpq service/address overrides, checks that
  the target has no application objects and uses a single transaction with
  `--exit-on-error`. It never uses `--clean`, `--create`, truncation or cloud
  upload. The isolated PostgreSQL service must not share production access.
  It must have no other concurrent clients; the emptiness check does not lock
  out a different administrator acting between check and restore.
- Limits: 100,000 private objects, 16 MiB per object, 100 GiB database dump,
  32 MiB encrypted-manifest plaintext, 16 KiB custom metadata per object.
  Oversized deployments fail rather than silently omit data. The product's
  stricter upload limits still apply. The whole `private/` prefix is included,
  including unclaimed objects; lifecycle retention must be separately approved.

Backups are sensitive even when encrypted. Store keys separately from backup
files, version/key-ID mapping in the approved secret manager, and test access
with the independent recovery reviewer. Retain the original TOTP encryption key
under separate controlled key escrow: a new key cannot decrypt restored TOTP
secrets. Recover that key through the approved procedure or force a reviewed
TOTP reenrollment; never silently disable two-factor authentication. Rotate
session secrets for an isolated recovery, disable external email/OCR/workflows,
and prevent restored sessions or workers from contacting production.

## Prerequisites: operator approval required

1. Approve the source project/bucket and private-bucket policy, data flow, region,
   destination region, retention/deletion and off-provider availability. S3
   credentials bypass Supabase RLS; issue a dedicated backup credential using
   the narrowest permissions the provider supports. This script never calls
   Put/Delete, but cannot narrow permissions granted by the provider.
2. Provision a dedicated PostgreSQL backup identity allowed to capture every
   application table and migration history without bypassing authorization
   accidentally. `pg_dump` must error, not silently skip RLS-protected rows.
   Use `PGSSLMODE=verify-full` and the provider CA; use a PostgreSQL client version
   compatible with the source server. Separately escrow approved role/grant
   provisioning: `--no-owner --no-acl` deliberately does not restore production
   role permissions, cluster globals or provider-level configuration.
3. Supply approved PostgreSQL executables at a fixed absolute `BACKUP_PG_BIN`.
   Node 24 and `pnpm install --frozen-lockfile` provide the existing S3 SDK.
   No new package or global install is required.
4. Provision a restricted encrypted destination, distinct from application
   storage. Do not place real backups inside this repo or its `.local/` folder.
   The local test harness uses `.local/` only for disposable synthetic fixtures.
5. Approve the exact freeze/resume procedure and backup window. Keep writes
   frozen until dump + documents + verification succeed. On failure, investigate
   the partial capture and follow the reviewed availability/resume procedure;
   the script never unfreezes traffic automatically.

## Runner configuration (not API runtime configuration)

Inject these values from the secret manager into a dedicated runner environment.
The scripts intentionally do **not** load `.env`, use `DATABASE_URL`, print
provider responses, or place passwords/keys in command arguments. Never paste
secret assignments into shell history. Safe templates are in
`scripts/operations/runner.env.example`; it contains no credentials and must not
be deployed with the public API.

| Name                                                                                        | Requirement                                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `BACKUP_ENCRYPTION_KEY`                                                                     | Canonical Base64 for 32 cryptographically random bytes; independently escrowed, not a memorable password |
| `BACKUP_DIRECTORY`                                                                          | New absolute leaf path on the approved backup destination; parent already exists                         |
| `BACKUP_PG_BIN`                                                                             | Absolute directory with approved `pg_dump`, `pg_restore`, `psql` executables                             |
| `BACKUP_PGHOST`, `BACKUP_PGPORT`, `BACKUP_PGDATABASE`, `BACKUP_PGUSER`, `BACKUP_PGPASSWORD` | Dedicated backup connection, supplied out of band                                                        |
| `BACKUP_PGSSLMODE`, `BACKUP_PGSSLROOTCERT`                                                  | `verify-full`; CA path when required by the provider                                                     |
| `BACKUP_S3_ENDPOINT`                                                                        | Exact approved `https://<project-ref>.storage.supabase.co/storage/v1/s3`                                 |
| `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`                                                      | Exact source region/private bucket                                                                       |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`                                    | Dedicated server-only backup credential                                                                  |
| `BACKUP_PRIVATE_BUCKET_CONFIRMED`                                                           | `BUCKET_PRIVATE_AND_BACKUP_IDENTITY_APPROVED`, only after actual verification                            |
| `BACKUP_WRITES_FROZEN`                                                                      | `ALL_APPLICATION_AND_WORKER_WRITES_FROZEN`, only during the independently verified freeze                |
| `BACKUP_RELEASE_SHA`                                                                        | Exact 40-character lowercase deployed Git SHA                                                            |
| `BACKUP_MIGRATION_VERSION`                                                                  | Verified latest applied migration tag; do not substitute the newest repo file if not applied             |

After provisioning and freezing writes:

```bash
node scripts/operations/backup.mjs backup
node scripts/operations/backup.mjs verify
```

Capture also verifies the completed archive before printing success. Both
commands must exit `0`. Preserve only backup ID, release SHA, UTC time, counts,
aggregate byte sizes, operator/reviewer and success status in operational logs.
Do not publish the archive or detailed manifest to CI/GitHub. Require periodic
restore drills, a monitored job schedule, stale-backup alerts, destination quota
alerts, separately reviewed retention cleanup and failure/recovery delivery.
Do not run this on Render's transient application filesystem. A policy such as
daily backups is a proposed schedule, not a schedule this commit has activated.

## Recovery commands

Provision a **new**, empty isolated local PostgreSQL database and restricted
encrypted extraction parent. Test recovery with synthetic backups first. A
PostgreSQL dump may contain executable SQL: restore only trusted archives from
the approved source/key to a disposable environment, never an elevated shared
production server.

Set `BACKUP_DIRECTORY`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_PG_BIN`, plus:

| Name                                   | Requirement                                                         |
| -------------------------------------- | ------------------------------------------------------------------- |
| `RESTORE_DIRECTORY`                    | New explicit absolute leaf on an isolated encrypted volume          |
| `RESTORE_CONFIRM`                      | `RESTORE_ISOLATED:` followed by that exact normalized absolute path |
| `RESTORE_ENCRYPTED_VOLUME`             | `ISOLATED_ENCRYPTED_VOLUME_APPROVED`                                |
| `RESTORE_PGHOST`, `RESTORE_PGPORT`     | Numeric loopback `127.0.0.1` or `::1`, isolated server port         |
| `RESTORE_PGDATABASE`                   | A newly-created `hch_restore_...` database, no application tables   |
| `RESTORE_PGUSER`, `RESTORE_PGPASSWORD` | Disposable local recovery identity                                  |
| `RESTORE_PGSSLMODE`                    | `verify-full`, or `disable` only for isolated loopback              |
| `RESTORE_DATABASE_CONFIRM`             | `RESTORE_DATABASE:` followed by exact `RESTORE_PGDATABASE`          |

```bash
node scripts/operations/backup.mjs restore-local
```

For authenticated extraction without any database connection:

```bash
node scripts/operations/backup.mjs extract
```

Extraction creates `database.dump` and `objects/private/...`, with
`.metadata.json` sidecars containing content type and private ACL custom
metadata. `EXTRACTED` means bytes only; `RESTORED_LOCAL` additionally means the
empty local PostgreSQL restore command succeeded. Neither means application
acceptance tests passed. Keep the entire plaintext tree on the isolated
encrypted volume and out of Git. A later isolated filesystem-profile app can
use the extraction directory as `LOCAL_OBJECT_STORAGE_DIR` and
`PRIVATE_OBJECT_DIR=/objects/private`, after role/grant provisioning and scanner
readiness. Do not start it against production integrations.

Cloud republishing/recovering to Supabase is deliberately **not automated** by
this restore command. Restore authenticated bytes and their custom metadata to
a separately approved private recovery bucket using a reviewed provider adapter;
verify anonymous denial, metadata, hashes/counts, DB roles, tenant separation
and application journeys before switching traffic. A basic `s3 sync` of bytes
does not preserve the application's ACL metadata and is not an acceptable
recovery procedure. Review/revoke recovery credentials and remove recovered
copies only after approval; the tool performs no automatic data deletion.

## Exact automated checks

```bash
node --test scripts/operations/backup.test.mjs
```

25 tests passed locally: authenticated encrypted roundtrip, empty bucket,
missing freeze, no overwrite, source race, failed dump, truncated stream,
manifest/database/object corruption, wrong key, swapped blobs, unexpected
artifact, restored metadata corruption, symlink/junction rejection, public ACL
rejection, duplicate inventory, encrypted-target confirmation, unsafe paths and
keys, canonical key validation, dedicated libpq environment and unsafe restore
target/override rejection. They contain no live credentials or real data.

The optional PostgreSQL test defaults to **skip**, not success, when the
explicit local tool directory is absent:

```powershell
$env:HCH_BACKUP_DRILL_PG_BIN = 'C:\approved\postgresql\bin'
node --test scripts/operations/backup-postgres.test.mjs
```

Linux CI can explicitly set `HCH_BACKUP_DRILL_PG_BIN` to its approved PostgreSQL
bin directory. `initdb` must run as a non-root user. The test creates an entirely
new `.local/backup-drill-*` cluster on numeric loopback, applies repository
migrations, tests restoration/corruption, and tears down only its own fixtures.
It must never use an existing PostgreSQL data directory or application env file.
