# Local production runtime (Windows)

This package runs the reviewed API and built responsive web application as one
same-origin process on `127.0.0.1:3000`, ready for the named Cloudflare Tunnel
in `infra/cloudflare`. It does not open an inbound port and it does not add a
Demo login, seed data, public registration, request interception, or a storage
fallback.

The scripts are intentionally fail-closed. They will not start the application
until the following are all true:

- `NODE_ENV=production`, `BIND_HOST=127.0.0.1`, port `3000`, and
  `OBJECT_STORAGE_PROVIDER=filesystem` are fixed to the reviewed values.
- PostgreSQL listens only on loopback and the application authenticates as a
  dedicated DML-only login. A different, non-superuser login owns and migrates
  the application database.
- PostgreSQL data, private objects, runtime state, configuration, and the
  user-bound DPAPI secret bundle are outside the Git checkout with allowlisted
  Windows ACLs.
- Every local upload is staged under a random name in a separate, empty EFS
  quarantine, scanned by an active Microsoft-signed Windows Defender binary,
  and removed before the API persists the object. Scanner errors fail closed.
- Database and private-object volumes are fully protected by BitLocker. The
  backup is on a different, also encrypted local volume.
- A recent disposable restore of both the PostgreSQL dump and every private
  object passed checksum and schema checks.

This is an operator-hosted, single-machine acceptance topology. Read
**Production limits** before putting any employee document into it.

## Prerequisites

Use PowerShell 7 (`pwsh`), Node 24, pnpm 11.19.0, PostgreSQL 16 client tools,
an active Microsoft Defender Antivirus installation, and a PostgreSQL 16
cluster dedicated to this application. Defender must run in Normal mode with
real-time protection and signatures no older than 48 hours. The machine needs
a separate BitLocker-protected backup drive. Run initialization and database
role changes from an elevated PowerShell window. Subsequent start, stop, and
backup commands must run under the same Windows identity that created the DPAPI
bundle and EFS quarantine.
The web process itself should not run elevated: an administrator records a
short-lived BitLocker/NTFS attestation, and the normal operator process checks
that evidence plus the current volume identity and health.

Do not use the ignored `.local` database or object directories for this
profile. Install or restore PostgreSQL with its `data_directory` outside this
repository, set `listen_addresses = '127.0.0.1'`, require SCRAM passwords in
`pg_hba.conf`, and restart PostgreSQL before initialization. If PostgreSQL runs
as a Windows service, obtain its dedicated service SID (for example with
`sc.exe showsid postgresql-x64-16`) and pass that SID to the initializer. Do not
allow `Everyone`, `Users`, `Authenticated Users`, or an unrelated service
account to read the database directory.

The application build must be reviewed and produced before database migration:

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build:production
```

## 1. Create configuration and DPAPI secrets

Choose exact local paths and a different encrypted backup volume. The command
prompts for two different 24+ character PostgreSQL passwords. It generates the
session and 32-byte TOTP encryption keys with the operating-system CSPRNG and
stores all four values as user-bound DPAPI `SecureString` values. It does not
print a secret or write one to Git.

```powershell
pwsh -NoProfile -File .\infra\local-production\Initialize-Production.ps1 `
  -BackupRoot "E:\WathaiqiHealthBackups" `
  -PostgresBin "C:\Program Files\PostgreSQL\16\bin" `
  -PostgresDataRoot "C:\ProgramData\WathaiqiHealth\postgresql-data" `
  -QuarantineRoot "C:\ProgramData\WathaiqiHealth\quarantine" `
  -PostgresWindowsServiceSid "<DEDICATED-POSTGRES-SERVICE-SID>" `
  -Confirm
```

Omit `-PostgresWindowsServiceSid` only when PostgreSQL intentionally runs under
the same restricted Windows operator identity. The generated files are:

```text
C:\ProgramData\WathaiqiHealth\config.json
C:\ProgramData\WathaiqiHealth\secrets\production-secrets.clixml
C:\ProgramData\WathaiqiHealth\quarantine
```

The initializer discovers the current platform copy of `MpCmdRun.exe`, verifies
its Microsoft Authenticode signature and approved installation path, and writes
that exact absolute path to the protected configuration. Pass
`-WindowsDefenderMpCmdRunPath` only when discovery is unavailable; never point
it at a copied binary or a path writable by application users. It also enables
EFS on the empty quarantine and keeps that root separate from runtime, objects,
database, backup, configuration, and secrets.

DPAPI is not a disaster-recovery secret manager: another Windows account or a
lost profile cannot decrypt this bundle. Escrow the database, session, and TOTP
keys separately in an approved password manager with controlled recovery.
Export and escrow the EFS certificate/private key under the same recovery
controls; otherwise a lost Windows profile can make an abandoned quarantine
artifact unrecoverable during incident response. Never copy plaintext secrets
into `.env`, a command line, a ticket, or this repo.

Refresh encrypted-volume evidence from an elevated window after any drive
change and at least every seven days:

```powershell
$config = "C:\ProgramData\WathaiqiHealth\config.json"
$secrets = "C:\ProgramData\WathaiqiHealth\secrets\production-secrets.clixml"

pwsh -NoProfile -File .\infra\local-production\Update-VolumeAttestation.ps1 `
  -ConfigPath $config -SecretsPath $secrets
```

The application preflight checks the attested volume IDs, NTFS, current health,
age, restricted ACL, and configured paths without requiring the web process to
run as a Windows administrator. It also verifies that the quarantine is EFS
encrypted and empty, Defender is active in Normal mode, its signature data is
fresh, `MpCmdRun.exe` is Microsoft-signed, and a bounded clean probe scan
succeeds. It never treats stale evidence, an abandoned file, or a scanner error
as success.

## 2. Establish database roles and migrate

The role initializer is a high-impact, explicit operation. It requires the
current PostgreSQL administrator password, creates/restricts four distinct
roles, transfers only the application database objects to the migration login,
removes unexpected memberships, and applies DML-only grants. It refuses system
databases, a non-loopback server, data under the wrong directory, unencrypted
storage, unsafe role names, and external role ownership.

```powershell
$config = "C:\ProgramData\WathaiqiHealth\config.json"
$secrets = "C:\ProgramData\WathaiqiHealth\secrets\production-secrets.clixml"

pwsh -NoProfile -File .\infra\local-production\Initialize-DatabaseRoles.ps1 `
  -ConfigPath $config -SecretsPath $secrets -PostgresAdministrator postgres `
  -Confirm

pwsh -NoProfile -File .\infra\local-production\Invoke-Migrations.ps1 `
  -ConfigPath $config -SecretsPath $secrets -Confirm
```

Migration runs as the DDL login, never as the API login. It uses the reviewed
Drizzle migrations and verifies the role boundary both before and after the
operation. Every migration invalidates old restore evidence.

## 3. Create and verify the first backup

The current local filesystem provider does not expose an atomic cross-resource
snapshot. For a consistent database/private-object backup, stop the Cloudflare
tunnel and API first. `New-Backup.ps1` refuses to run while port 3000 is active.
It creates a PostgreSQL custom-format dump, copies retained private objects
without following reparse points, records every SHA-256 checksum, validates the
dump structure, then atomically promotes the completed backup directory.

```powershell
pwsh -NoProfile -File .\infra\local-production\New-Backup.ps1 `
  -ConfigPath $config -SecretsPath $secrets
```

Use the exact completed backup path printed by that command:

```powershell
pwsh -NoProfile -File .\infra\local-production\Test-Restore.ps1 `
  -ConfigPath $config `
  -BackupPath "E:\WathaiqiHealthBackups\backup-<UTC>-<ID>" `
  -PostgresAdministrator postgres -Confirm
```

The restore drill validates the manifest and all checksums, restores into a
random disposable database and a restricted temporary object directory, checks
required application tables, then removes both disposable targets. Only after
successful cleanup does it write restricted, non-sensitive restore evidence.
`Start-Production.ps1` rejects missing, changed, failed, or older-than-30-day
evidence.

## 4. Preflight and start

```powershell
pwsh -NoProfile -File .\infra\local-production\Test-Preflight.ps1 `
  -ConfigPath $config -SecretsPath $secrets

pwsh -NoProfile -File .\infra\local-production\Start-Production.ps1 `
  -ConfigPath $config -SecretsPath $secrets
```

The start script constructs a minimal child-process environment, strips
inherited Node/proxy/tooling variables by using a new environment, loads secrets
only into the child process, and pins `MALWARE_SCAN_PROVIDER=windows-defender`,
the verified Defender executable, the protected quarantine root, and a bounded
scan timeout. It starts the reviewed `dist/index.mjs` in a hidden window, writes
restricted logs and a verified PID record outside Git, and waits for
`/api/readyz`. On a readiness failure it stops only the process it just created
and fails.

Confirm the running origin again:

```powershell
pwsh -NoProfile -File .\infra\local-production\Test-Preflight.ps1 `
  -ConfigPath $config -SecretsPath $secrets -RequireRunning
```

Then follow `infra/cloudflare/README.md`. The tunnel must route only
`app.wathaiqihealth.com` to `http://127.0.0.1:3000`, with its own credential
outside Git. Run the Cloudflare preflight and public verifier before handing the
URL to anyone.

## 5. Stop and restart safely

Stop the Cloudflare connector first so no public request reaches a terminating
origin, then stop the application:

```powershell
pwsh -NoProfile -File .\infra\local-production\Stop-Production.ps1 `
  -ConfigPath $config -Confirm
```

The stop script compares PID start time, executable path, command line, entry
point, and repository root before terminating anything. A malformed or reused
PID fails closed. After a planned backup or reviewed update, rerun preflight,
start the application, start the tunnel, and run the public verifier.

These scripts do not install an automatic-start service or Scheduled Task.
Doing so safely requires a dedicated Windows service identity, recovery policy,
DPAPI/secret design for that identity, dependency ordering (PostgreSQL, app,
then tunnel), and tested shutdown behavior. Do not schedule a command that
contains a password or tunnel token.

## Production limits

Even after every check passes, this machine remains a single point of failure.
Cloudflare Tunnel supplies outbound-only transport and edge protections; it
does not provide managed compute, high availability, PostgreSQL PITR,
transactional cross-resource snapshots, off-site replication, endpoint
security, UPS capacity, tested machine replacement, incident response, or a
health-data processing agreement. The required offline backup window causes
brief unavailability. A second encrypted local disk protects against failure of
the data disk, but not theft, fire, ransomware, or loss of the whole machine.

Before real employee documents, an accountable operator still needs to approve
Saudi data-residency/privacy requirements, endpoint hardening and patching,
least-privilege Windows administrators, monitoring and alerting, log retention,
backup rotation plus an off-site encrypted copy, restore drills after every
schema/storage change, Defender health/signature alerting, malware incident
handling, EFS key recovery, and disaster-recovery objectives. Email, OCR, and n8n
automation remain disabled until their region, retention, credentials,
allowlists, failure handling, and data-processing terms are approved.

For a healthcare production launch, move to reviewed managed or redundant
infrastructure. Do not describe this single-host path as highly available or
use a successful local build/restore as proof of production compliance.
