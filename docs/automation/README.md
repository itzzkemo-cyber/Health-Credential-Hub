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
- it atomically binds each event UUID to a stable SHA-256 digest of the exact body, so
  an identical retry is acknowledged while a reused UUID with changed content
  is rejected;
- it stores only event ID, facility ID, event type, exact-body SHA-256, and
  timestamps;
- it does not store or forward employee/credential IDs, document content,
  object URLs, OCR results, contact data, credentials, or authentication data.

ببساطة: فائدته أن أحداث الوثائق والموظفين والدعوات والجداول وطلبات المناوبات
تصل إلى طبقة الأتمتة بشكل موثوق وآمن، من دون إرسال الملف نفسه أو هوية الموظف
إلى مزود خارجي. الحزمة لا تشغّل رسائل أو مهام خارجية حتى يعتمد المشغل
الاستضافة والمنطقة والاحتفاظ.

## Minimized event contract

Every envelope carries only `id`, `type`, `occurredAt`, `facilityId`, and
`data`. The receiver accepts these exact `data` shapes and rejects extra keys:

| Event type                           | Exact `data` payload                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `credential.created`                 | `{}`                                                                                 |
| `credential.verification_changed`    | `{ "isVerified": boolean }`                                                          |
| `credential.expiry_due`              | `{ "thresholdDays": 90\|60\|30\|15\|7\|1\|0 }`                                       |
| `credential.lifecycle_changed`       | `{ "change": "updated"\|"deleted" }`                                                 |
| `employee.lifecycle_changed`         | `{ "change": "created"\|"updated"\|"activated"\|"deactivated" }`                     |
| `employee.invitation_changed`        | `{ "change": "created"\|"revoked"\|"accepted" }`                                     |
| `schedule.lifecycle_changed`         | `{ "change": "created"\|"updated"\|"published"\|"reopened"\|"cancelled" }`           |
| `schedule_request.lifecycle_changed` | `{ "change": "submitted"\|"withdrawn"\|"approved"\|"rejected"\|"approval_revoked" }` |

No resource ID, employee contact/profile field, document metadata/body, signed
URL, OCR value, credential, or authentication value crosses this boundary.

## Files

- `wathaiqi-n8n-receiver.workflow.json`: inactive n8n workflow import.
- `n8n-inbox.sql`: dedicated receipt table and least-privilege database role.
- `n8n.env.example`: privacy-oriented self-hosted n8n settings with no secrets.
- `verify-package.mjs`: offline structural and security-contract checks.

## Mandatory deployment boundary

Use a self-hosted n8n instance and PostgreSQL controlled by the operator in an
approved region. The receipt ledger must be a separate database named
`wathaiqi_n8n_receipts`; do not put its HMAC secret or receipt table in the main
n8n database, even on the same PostgreSQL cluster. Render keeps the managed
`wathaiqi_n8n` role as owner of the main database and provider break-glass
identity, while the limited LOGIN role `wathaiqi_n8n_app` must own the `public`
schema and every existing n8n object in it. The limited role receives only
main-database `CONNECT`, `CREATE`, and `TEMPORARY`; it remains `NOCREATEDB` and
`NOCREATEROLE`. The managed role must never appear in the n8n service
environment or workflow credential store.

This same-cluster layout limits a compromised n8n process; it does not protect
against deliberate use of the offline provider administrator. Keep that
credential outside Render service environment variables, suspend n8n throughout
bootstrap, and audit all connectable databases. `PUBLIC` database privileges are
additive. Render's provider-owned maintenance database is the sole exception:
`postgres` owned by `postgres` may retain `PUBLIC CONNECT` and `TEMPORARY`, but
all n8n app/receiver LOGIN roles must have `CREATE = false` there. This residual
provider constraint permits a session, temporary objects, and the catalog
metadata PostgreSQL exposes to connected roles; it does not grant access to the
main n8n or receipt databases. Point every service credential at its explicit
database, never use `postgres`, and stop if any fourth connectable database or
any other exception appears. Do not reuse the Health Credential Hub application
database or any of its users. The n8n ingress must use HTTPS.
`n8n.env.example` shows the specifically reviewed example image
`n8nio/n8n:1.123.76`; it does not pull or deploy that image. Re-review the pinned
release and its configuration names before production or any upgrade.

The free Render pilot is pinned to the maintained v1 compatibility release
because the current v2 image and its internal task runners exceeded the free
service memory limit during measured startup. This is a pilot constraint, not
the target production architecture. A production deployment needs enough
memory for a current v2 image and isolated external task runners.

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

   The verifier intentionally expects an inactive workflow, facility `1` only,
   no embedded credentials, and no n8n Crypto node. Stop if it fails.

2. Suspend n8n and keep it stopped through this entire maintenance sequence.
   From the provider secret view, retrieve the managed `wathaiqi_n8n` connection
   only into the operator's temporary process. Generate three independent random
   passwords for `wathaiqi_n8n_app`, `wathaiqi_n8n_receiver_operator`, and
   `wathaiqi_n8n_receiver_login`; never place them in SQL text, Git, shell
   history, chat, or screenshots. Create or idempotently reconcile these exact
   roles. The `CREATE ROLE` statements below are first-run shapes; on a retry,
   inspect the existing role and use `ALTER ROLE` to reconcile every listed
   attribute instead of creating a duplicate:

   ```sql
    CREATE ROLE wathaiqi_n8n_app
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
      NOREPLICATION NOBYPASSRLS;
    CREATE ROLE wathaiqi_n8n_receipts_owner
     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
     NOREPLICATION NOBYPASSRLS;
   CREATE ROLE wathaiqi_n8n_secret_owner
     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
     NOREPLICATION NOBYPASSRLS;
   CREATE ROLE wathaiqi_n8n_verifier_owner
     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
     NOREPLICATION NOBYPASSRLS;
   CREATE ROLE wathaiqi_n8n_inbox_writer
     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
     NOREPLICATION NOBYPASSRLS;
   CREATE ROLE wathaiqi_n8n_receiver_operator
     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
     NOREPLICATION NOBYPASSRLS;
   CREATE ROLE wathaiqi_n8n_receiver_login
     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
     NOREPLICATION NOBYPASSRLS;
   ```

   PostgreSQL utility DDL does not accept a password as `$1`. Set each password
   through the provider's secret/reset path or an interactive `psql \password`
   prompt. A reviewed driver helper may instead bind the secret into a
   transaction-local `set_config` value and quote it only inside a fixed
   `format('%L')` statement; never interpolate it in application code. The
   receiver operator is a
   receipt-schema upgrade/rotation identity: keep it in the operator password
   manager, never in n8n or its credential store. The receiver login is for the
   one PostgreSQL workflow node only.

3. Inventory every connectable database and the current `public`-schema objects.
   Keep `wathaiqi_n8n` as the main database owner, and use targeted `ALTER ...
   OWNER` statements only; do not use `REASSIGN OWNED`, because it can touch
   shared objects and is not permitted by this managed-provider plan:

   ```sql
   SELECT database.datname, owner.rolname AS owner
   FROM pg_catalog.pg_database AS database
   JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
   WHERE database.datallowconn AND NOT database.datistemplate
   ORDER BY database.datname;

   SELECT namespace.nspname, class.relkind, class.relname,
     owner.rolname AS owner
   FROM pg_catalog.pg_class AS class
   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
   JOIN pg_catalog.pg_roles AS owner ON owner.oid = class.relowner
   WHERE namespace.nspname = 'public'
   ORDER BY class.relkind, class.relname;
   ```

   Grant only temporary bootstrap paths inside a transaction, give the app role
   its three database privileges, and transfer the `public` schema plus each
   current n8n table, partitioned table, sequence, view, materialized view,
   foreign table, routine, and standalone type to it with type-correct targeted
   `ALTER ... OWNER` statements. Table ownership carries its indexes. Refuse
   unknown object kinds and verify zero old-owner objects before commit. Then
   create the receipt database outside a transaction. Replace the quoted
   placeholder with the exact `DB_POSTGRESDB_DATABASE` value:

   ```sql
    BEGIN;
    GRANT wathaiqi_n8n_app,
      wathaiqi_n8n_receipts_owner,
      wathaiqi_n8n_secret_owner,
      wathaiqi_n8n_verifier_owner
      TO wathaiqi_n8n
      WITH ADMIN FALSE, INHERIT TRUE, SET TRUE
      GRANTED BY CURRENT_USER;
    GRANT wathaiqi_n8n_receipts_owner,
      wathaiqi_n8n_secret_owner,
      wathaiqi_n8n_verifier_owner
      TO wathaiqi_n8n_receiver_operator
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

    REVOKE ALL PRIVILEGES ON DATABASE "<actual-main-n8n-database>"
      FROM PUBLIC, wathaiqi_n8n_app, wathaiqi_n8n_receiver_login,
        wathaiqi_n8n_receiver_operator;
    GRANT CONNECT, CREATE, TEMPORARY
      ON DATABASE "<actual-main-n8n-database>" TO wathaiqi_n8n_app;
    ALTER SCHEMA public OWNER TO wathaiqi_n8n_app;
    -- Generate and review one type-correct ALTER ... OWNER statement for every
    -- inventoried object still owned by wathaiqi_n8n before COMMIT.
    COMMIT;

    CREATE DATABASE wathaiqi_n8n_receipts
      OWNER wathaiqi_n8n_receipts_owner
      TEMPLATE template0;
   REVOKE ALL PRIVILEGES ON DATABASE wathaiqi_n8n_receipts
     FROM PUBLIC, wathaiqi_n8n;
   GRANT CONNECT ON DATABASE wathaiqi_n8n_receipts
     TO wathaiqi_n8n_receiver_operator, wathaiqi_n8n_receiver_login;

    ```

   Run the sequence with `ON_ERROR_STOP` (or a driver `try/finally`). Connect
   explicitly to `wathaiqi_n8n_receipts` and run `n8n-inbox.sql`. Its
   preflight refuses any other database, a LOGIN receipt owner, missing
   SET-only operator ownership memberships, unsafe application-role attributes,
   or effective application/receiver CONNECT on any unexpected database. The script
   grants the workflow login only database CONNECT plus the schema USAGE needed
   to EXECUTE `verify_and_claim_event_receipt`; it receives no table, secret,
   DDL, application, or main-n8n database access. Its postflight expands every
   ACL on the receipt database, three schemas, two sensitive tables, and the
   SECURITY DEFINER function; any unknown grantee, extra privilege, or grant
   option aborts the transaction instead of preserving stale access.

   PostgreSQL 16 and newer give a non-superuser `CREATEROLE` creator an automatic
   ADMIN-only membership (`INHERIT FALSE`, `SET FALSE`) in each role it creates,
   granted by the bootstrap superuser. The creator cannot remove that automatic
   row. `n8n-inbox.sql` removes the administrator's additional self-grants with
   `GRANTED BY CURRENT_USER`, rejects any remaining INHERIT/SET path, and removes
   every receiver membership from `wathaiqi_n8n_app`. If database creation or
   receiver installation fails after the main transfer commits, keep n8n
   suspended, revoke the temporary receipt-database CONNECT from
   `wathaiqi_n8n`, and revoke its self-granted app/owner memberships with
   `GRANTED BY CURRENT_USER` before retrying. Do not mistake the immutable
   ADMIN-only creator rows for an INHERIT/SET path. This is why the managed
   administrator must remain offline rather than being used by n8n. See the
   [PostgreSQL 17 role-attributes documentation](https://www.postgresql.org/docs/17/role-attributes.html).

   Confirm ownership and the complete CONNECT matrix after commit. Inspect every
   non-template database. The only reviewed provider exception is `postgres`
   owned by `postgres`, where CONNECT/TEMPORARY may be effective but CREATE must
   be false for app, receiver, and operator. Resolve any other direct,
   role-derived, or `PUBLIC` path—or stop:

   ```sql
    SELECT database.datname,
      owner.rolname AS owner,
      pg_catalog.has_database_privilege(
        'wathaiqi_n8n_app', database.datname, 'CONNECT'
      ) AS app_connect,
      pg_catalog.has_database_privilege(
        'wathaiqi_n8n_receiver_login', database.datname, 'CONNECT'
      ) AS receiver_connect,
      pg_catalog.has_database_privilege(
        'wathaiqi_n8n_receiver_operator', database.datname, 'CONNECT'
      ) AS operator_connect
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
    WHERE database.datallowconn AND NOT database.datistemplate
   ORDER BY database.datname;
    ```

   While connected to the main database, inventory the n8n relations, routines,
   and standalone types in `public` (excluding extension-owned members). Each
   foreign-owner count must be zero. Confirm the schema owner, then run the DDL
   probe through a direct `wathaiqi_n8n_app` connection; it must roll back:

   ```sql
   SELECT pg_catalog.count(*) AS foreign_relation_owner_count
   FROM pg_catalog.pg_class AS object
   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = object.relnamespace
   JOIN pg_catalog.pg_roles AS owner ON owner.oid = object.relowner
   WHERE namespace.nspname = 'public'
     AND object.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
     AND owner.rolname <> 'wathaiqi_n8n_app'
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_depend AS dependency
       WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
         AND dependency.objid = object.oid AND dependency.deptype = 'e'
     );

   SELECT pg_catalog.count(*) AS foreign_routine_owner_count
   FROM pg_catalog.pg_proc AS object
   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = object.pronamespace
   JOIN pg_catalog.pg_roles AS owner ON owner.oid = object.proowner
   WHERE namespace.nspname = 'public'
     AND owner.rolname <> 'wathaiqi_n8n_app'
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_depend AS dependency
       WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
         AND dependency.objid = object.oid AND dependency.deptype = 'e'
     );

   SELECT pg_catalog.count(*) AS foreign_type_owner_count
   FROM pg_catalog.pg_type AS object
   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = object.typnamespace
   JOIN pg_catalog.pg_roles AS owner ON owner.oid = object.typowner
   LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = object.typrelid
   WHERE namespace.nspname = 'public'
     AND object.typtype IN ('c', 'd', 'e', 'r', 'm')
     AND (object.typrelid = 0 OR relation.relkind = 'c')
     AND owner.rolname <> 'wathaiqi_n8n_app'
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_type AS element_type
       WHERE element_type.typarray = object.oid
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_depend AS dependency
       WHERE dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
         AND dependency.objid = object.oid AND dependency.deptype = 'e'
     );

   SELECT owner.rolname AS public_schema_owner
   FROM pg_catalog.pg_namespace AS namespace
   JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
   WHERE namespace.nspname = 'public';

   BEGIN;
   CREATE TYPE public.wathaiqi_bootstrap_probe_state AS ENUM ('ready');
   CREATE TABLE public.wathaiqi_bootstrap_ddl_probe (
     id integer PRIMARY KEY,
     state public.wathaiqi_bootstrap_probe_state NOT NULL
   );
   CREATE INDEX wathaiqi_bootstrap_ddl_probe_state_idx
     ON public.wathaiqi_bootstrap_ddl_probe (state);
   ALTER TABLE public.wathaiqi_bootstrap_ddl_probe ADD COLUMN checked boolean;
   ROLLBACK;
   ```

   All three counts must be zero and the `public` schema must be owned by
   `wathaiqi_n8n_app`. Run the probe through an app-role connection, not after
   `SET ROLE` from the provider administrator.

   For later reviewed schema upgrades, retrieve the break-glass operator
   credential, connect only to `wathaiqi_n8n_receipts`, and `SET ROLE` to the
   minimum one of `wathaiqi_n8n_receipts_owner`,
   `wathaiqi_n8n_secret_owner`, or `wathaiqi_n8n_verifier_owner`. Its
   memberships are SET-capable but not inherited. Return it to the password
   manager and close the session immediately afterward.

4. While n8n is still suspended, set its main database user to
   `wathaiqi_n8n_app` and bind only that role's new password. Search the complete
   service configuration to prove `wathaiqi_n8n` is absent. Only after the
   ownership query, DDL probe, role-membership audit, and complete CONNECT matrix
   pass may the service start. Verify n8n can read its existing data and stop
   immediately on a permission error. Never fall back to the managed
   administrator in the service.

5. Configure the remaining n8n settings from `n8n.env.example`. For the pinned v1 image,
   set `WEBHOOK_URL` and `N8N_EDITOR_BASE_URL` to the approved public HTTPS
   origin. Re-check the variable names during a v2 upgrade. Generate a stable
   `N8N_ENCRYPTION_KEY` in a password manager and back it up securely.
6. Generate 32 random bytes once and encode them as canonical Base64 on an
   isolated administrator workstation:

   ```powershell
   $randomBytes = [byte[]]::new(32)
   [Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
   $automationSecret = [Convert]::ToBase64String($randomBytes)
   ```

   Store this exact Base64 value as `AUTOMATION_WEBHOOK_SECRET` in the worker's
   secret manager. Do not put it in n8n credentials. Using the receiver operator
   connection to `wathaiqi_n8n_receipts`, bind the same value as `$1` in this
   parameterized statement:

   ```sql
   BEGIN;
   SET LOCAL ROLE wathaiqi_n8n_secret_owner;
   INSERT INTO wathaiqi_automation_private.receiver_secrets (
     key_id, secret_bytes, updated_at
   )
   VALUES (1, pg_catalog.decode($1, 'base64'), pg_catalog.clock_timestamp())
   ON CONFLICT (key_id) DO UPDATE
     SET secret_bytes = EXCLUDED.secret_bytes,
         updated_at = EXCLUDED.updated_at;
   COMMIT;
   ```

   Do not interpolate the secret into SQL text. The receiver function reads it
   under a separate NOLOGIN owner; the workflow login cannot select that table.

7. Import `wathaiqi-n8n-receiver.workflow.json`. Attach one PostgreSQL
   credential to `Verify and claim in PostgreSQL`, using
   `wathaiqi_n8n_receiver_login`, database `wathaiqi_n8n_receipts`, and TLS.
   Never attach the main n8n DB owner or receiver operator credential.
8. Keep the checked-in allowlist at `[1]`. It must match
   `AUTOMATION_FACILITY_ALLOWLIST=1`; adding another facility requires a
   separate reviewed source and receiver change plus two-tenant isolation tests.
9. In a non-production environment, publish the workflow and test a synthetic
   signed event. Confirm valid=202, same UUID plus same body=200, same UUID plus
   changed body=409, invalid signature=401, stale timestamp=401, unlisted
   facility=403, and database failure=5xx. The 202/200 JSON acknowledgement
   must include the exact `eventId`; the worker rejects a mismatched or missing
   event ID even when an intermediary returns a successful HTTP status.
10. Review the n8n execution-retention configuration and verify that successful,
   failed, and manual execution bodies are not retained. Run `n8n audit` and
   restrict workflow/credential editors.
11. Only after explicit approval, set the worker URL/host allowlist and secret,
    then enable the outbox and webhook switches for the reviewed facilities.

## Pilot-only embedded worker

If a pilot hosting plan cannot run a separate worker process, the API can run
the same continuous delivery loop after the HTTP server and database boundary
checks are ready:

```dotenv
AUTOMATION_OUTBOX_ENABLED=true
AUTOMATION_WEBHOOK_ENABLED=true
AUTOMATION_EMBEDDED_WORKER_ENABLED=true
```

The embedded switch is independently parsed, defaults to false, and refuses to
start unless `readAutomationConfig` returns a fully enabled configuration. The
API forwards `SIGINT` and `SIGTERM` through an `AbortController`, stops HTTP
intake, waits for the current bounded cycle, and then closes the database pool.
Unexpected detached-worker failures are logged only as safe error
classifications, without provider messages, payloads, URLs, or secrets.

This mode is a cost-aware pilot fallback, not the production topology. It
shares CPU, memory, lifecycle, and database connection budget with the public
API; restarts can delay delivery and horizontal API scaling creates multiple
pollers. Claim locking makes overlapping pollers safe, but production should
still use a dedicated continuous worker with independent health monitoring and
resource limits.

## Idempotency and downstream actions

The imported workflow is intentionally only an authenticated receipt endpoint.
It returns 202 after the receipt row is inserted and echoes that `eventId` in a
strict acknowledgement. It returns 200 only when the event UUID and the stable
exact-body SHA-256 both match an existing receipt, again echoing that event ID. It
returns 409 if the UUID exists with another digest, preventing a replay from
silently changing the meaning of an accepted event. A lost HTTP response can
therefore be retried safely with the same exact body.

The SECURITY DEFINER database wrapper performs HMAC-SHA256 verification over
`timestamp + "." + exact_raw_body`, applies the five-minute replay window, and
computes an unkeyed SHA-256 over the exact raw body for the stable idempotency
digest. The UUID and timestamp in every minimized envelope prevent this digest
from becoming a useful dictionary of business data, and keeping it independent
of the signing key preserves exact retries across a coordinated key rotation.
It uses a best-effort fixed-work 32-byte XOR comparison and an explicit
`pg_catalog` search path. Only the hexadecimal body digest is stored; the raw
body and request signature are never written to a table.

Do not attach email, chat, HTTP Request, AI, document, or storage nodes directly
to this receiver. Build a separate, reviewed dispatcher that claims pending
receipt IDs with its own status/lease and provider idempotency key. If that
dispatcher needs more business context, call a narrowly scoped internal API
after authorization; never expand this webhook to carry document or employee
details.

## Rotation

The current sender supports one HMAC secret. Rotation therefore requires a
planned maintenance window or a reviewed dual-key receiver extension: pause
delivery, update the private receiver secret with the parameterized operator
statement, update the worker's `AUTOMATION_WEBHOOK_SECRET` to that exact
canonical Base64 value, send a synthetic event, then resume. Never give the
workflow login secret-table access and never delete inbox receipts during
rotation.
