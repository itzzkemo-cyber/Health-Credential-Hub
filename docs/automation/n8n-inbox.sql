-- Run from a suspended n8n maintenance window as the offline Render-managed
-- break-glass role wathaiqi_n8n, connected to the dedicated receiver database.
-- This is not an application migration and must never run against the Health
-- Credential Hub application database.
--
-- The script deliberately creates separate NOLOGIN owners for the receiver
-- database, secret, and verification boundaries. The n8n workflow login must
-- only inherit wathaiqi_n8n_inbox_writer.
--
-- IMPORTANT: first use the idempotent bootstrap sequence in README.md to move
-- ownership of the main n8n schema and every existing n8n object from
-- wathaiqi_n8n to the limited runtime wathaiqi_n8n_app. The managed role remains
-- the database owner only as an offline break-glass identity. PostgreSQL does
-- not allow CREATE DATABASE inside this transaction. The bootstrap temporarily grants the
-- break-glass role only the memberships and CONNECT needed to run this file;
-- this file removes them again before commit.

BEGIN;

DO $preflight$
DECLARE
  actual_database_owner text;
  expected_role text;
  role_record record;
  database_record record;
  main_database_count integer;
  operator_membership_count integer;
  receiver_login_membership_count integer;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 160000 THEN
    RAISE EXCEPTION
      'receiver bootstrap requires PostgreSQL 16 or newer role-membership options';
  END IF;

  IF current_user <> 'wathaiqi_n8n'
    OR session_user <> 'wathaiqi_n8n'
  THEN
    RAISE EXCEPTION
      'receiver installation requires the offline wathaiqi_n8n break-glass session';
  END IF;

  IF pg_catalog.current_database() <> 'wathaiqi_n8n_receipts' THEN
    RAISE EXCEPTION
      'refusing to install receiver objects in database %',
      pg_catalog.current_database();
  END IF;

  SELECT role.rolname
    INTO actual_database_owner
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS role ON role.oid = database.datdba
    WHERE database.datname = pg_catalog.current_database();

  IF actual_database_owner <> 'wathaiqi_n8n_receipts_owner' THEN
    RAISE EXCEPTION
      'receiver database owner is %, expected wathaiqi_n8n_receipts_owner',
      actual_database_owner;
  END IF;

  FOREACH expected_role IN ARRAY ARRAY[
    'wathaiqi_n8n_receipts_owner',
    'wathaiqi_n8n_secret_owner',
    'wathaiqi_n8n_verifier_owner',
    'wathaiqi_n8n_inbox_writer',
    'wathaiqi_n8n_receiver_operator',
    'wathaiqi_n8n_receiver_login',
    'wathaiqi_n8n_app',
    'wathaiqi_n8n'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = expected_role
    ) THEN
      RAISE EXCEPTION 'missing prerequisite role %', expected_role;
    END IF;
  END LOOP;

  FOR role_record IN
    SELECT
      role.rolname,
      role.rolcanlogin,
      role.rolinherit,
      role.rolsuper,
      role.rolcreatedb,
      role.rolcreaterole,
      role.rolreplication,
      role.rolbypassrls
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname IN (
      'wathaiqi_n8n_receipts_owner',
      'wathaiqi_n8n_secret_owner',
      'wathaiqi_n8n_verifier_owner',
      'wathaiqi_n8n_inbox_writer'
    )
  LOOP
    IF role_record.rolcanlogin
      OR role_record.rolinherit
      OR role_record.rolsuper
      OR role_record.rolcreatedb
      OR role_record.rolcreaterole
      OR role_record.rolreplication
      OR role_record.rolbypassrls
    THEN
      RAISE EXCEPTION 'unsafe NOLOGIN owner role attributes for %',
        role_record.rolname;
    END IF;
  END LOOP;

  FOR role_record IN
    SELECT
      role.rolname,
      role.rolcanlogin,
      role.rolinherit,
      role.rolsuper,
      role.rolcreatedb,
      role.rolcreaterole,
      role.rolreplication,
      role.rolbypassrls
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname IN (
      'wathaiqi_n8n_app',
      'wathaiqi_n8n_receiver_operator',
      'wathaiqi_n8n_receiver_login'
    )
  LOOP
    IF NOT role_record.rolcanlogin
      OR role_record.rolsuper
      OR role_record.rolcreatedb
      OR role_record.rolcreaterole
      OR role_record.rolreplication
      OR role_record.rolbypassrls
      OR (
        role_record.rolname = 'wathaiqi_n8n_app'
        AND NOT role_record.rolinherit
      )
      OR (
        role_record.rolname = 'wathaiqi_n8n_receiver_operator'
        AND role_record.rolinherit
      )
      OR (
        role_record.rolname = 'wathaiqi_n8n_receiver_login'
        AND NOT role_record.rolinherit
      )
    THEN
      RAISE EXCEPTION 'unsafe limited LOGIN role attributes for %',
        role_record.rolname;
    END IF;
  END LOOP;

  SELECT pg_catalog.count(*)::integer
    INTO operator_membership_count
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_receiver_operator'
      AND granted_role.rolname IN (
        'wathaiqi_n8n_receipts_owner',
        'wathaiqi_n8n_secret_owner',
        'wathaiqi_n8n_verifier_owner'
      )
      AND NOT membership.admin_option
      AND membership.set_option
      AND NOT membership.inherit_option;
  IF operator_membership_count <> 3 THEN
    RAISE EXCEPTION
      'receiver operator requires SET-only membership in all three NOLOGIN owner roles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_receiver_operator'
      AND (
        granted_role.rolname NOT IN (
          'wathaiqi_n8n_receipts_owner',
          'wathaiqi_n8n_secret_owner',
          'wathaiqi_n8n_verifier_owner'
        )
        OR membership.admin_option
        OR membership.inherit_option
        OR NOT membership.set_option
      )
  ) THEN
    RAISE EXCEPTION
      'receiver operator has an unexpected or unsafe role membership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_app'
  ) THEN
    RAISE EXCEPTION 'n8n application runtime must not have any role membership';
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO receiver_login_membership_count
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_receiver_login'
      AND granted_role.rolname = 'wathaiqi_n8n_inbox_writer'
      AND NOT membership.admin_option
      AND membership.inherit_option;
  IF receiver_login_membership_count > 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_receiver_login'
      AND (
        granted_role.rolname <> 'wathaiqi_n8n_inbox_writer'
        OR membership.admin_option
        OR NOT membership.inherit_option
      )
  ) THEN
    RAISE EXCEPTION
      'receiver workflow login has an unexpected or unsafe role membership';
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO main_database_count
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = database.datdba
    WHERE owner_role.rolname = 'wathaiqi_n8n'
      AND database.datname <> 'wathaiqi_n8n_receipts'
      AND database.datallowconn
      AND NOT database.datistemplate
      AND pg_catalog.has_database_privilege(
        'wathaiqi_n8n_app', database.datname, 'CONNECT'
      )
      AND pg_catalog.has_database_privilege(
        'wathaiqi_n8n_app', database.datname, 'CREATE'
      )
      AND pg_catalog.has_database_privilege(
        'wathaiqi_n8n_app', database.datname, 'TEMPORARY'
      );
  IF main_database_count <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one main n8n database delegated to wathaiqi_n8n_app, found %',
      main_database_count;
  END IF;

  -- CONNECT grants are additive. PUBLIC must be revoked on the main database,
  -- and neither receiver LOGIN may cross into the n8n application database.
  FOR database_record IN
    SELECT
      database.datname,
      owner_role.rolname AS owner_name,
      owner_role.rolname = 'wathaiqi_n8n'
        AND pg_catalog.has_database_privilege(
          'wathaiqi_n8n_app', database.datname, 'CREATE'
        )
        AND pg_catalog.has_database_privilege(
          'wathaiqi_n8n_app', database.datname, 'TEMPORARY'
        ) AS is_main_database
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = database.datdba
    WHERE database.datname <> 'wathaiqi_n8n_receipts'
      AND database.datallowconn
      AND NOT database.datistemplate
  LOOP
    IF database_record.is_main_database THEN
      IF NOT pg_catalog.has_database_privilege(
          'wathaiqi_n8n_app', database_record.datname, 'CONNECT'
        ) OR pg_catalog.has_database_privilege(
          'wathaiqi_n8n_receiver_login', database_record.datname, 'CONNECT'
        ) OR pg_catalog.has_database_privilege(
          'wathaiqi_n8n_receiver_operator', database_record.datname, 'CONNECT'
        ) OR pg_catalog.has_database_privilege(
          'wathaiqi_n8n_receiver_login', database_record.datname, 'CREATE'
        ) OR pg_catalog.has_database_privilege(
          'wathaiqi_n8n_receiver_operator', database_record.datname, 'CREATE'
        )
      THEN
        RAISE EXCEPTION
          'unsafe privilege matrix for main n8n database %',
          database_record.datname;
      END IF;
    ELSIF database_record.datname = 'postgres'
      AND database_record.owner_name = 'postgres'
    THEN
      -- Render retains PUBLIC CONNECT/TEMPORARY on this maintenance database.
      -- Accept that exact provider database only when no runtime can CREATE.
      IF pg_catalog.has_database_privilege(
          'wathaiqi_n8n_app', database_record.datname, 'CREATE'
        ) OR pg_catalog.has_database_privilege(
          'wathaiqi_n8n_receiver_login', database_record.datname, 'CREATE'
        ) OR pg_catalog.has_database_privilege(
          'wathaiqi_n8n_receiver_operator', database_record.datname, 'CREATE'
        )
      THEN
        RAISE EXCEPTION
          'runtime role has CREATE on provider maintenance database';
      END IF;
    ELSE
      RAISE EXCEPTION
        'unexpected connectable database % owned by %',
        database_record.datname,
        database_record.owner_name;
    END IF;
  END LOOP;
END
$preflight$;

CREATE SCHEMA IF NOT EXISTS wathaiqi_automation_private
  AUTHORIZATION wathaiqi_n8n_secret_owner;
ALTER SCHEMA wathaiqi_automation_private
  OWNER TO wathaiqi_n8n_secret_owner;

CREATE SCHEMA IF NOT EXISTS wathaiqi_automation_crypto
  AUTHORIZATION wathaiqi_n8n_verifier_owner;
ALTER SCHEMA wathaiqi_automation_crypto
  OWNER TO wathaiqi_n8n_verifier_owner;

DO $pgcrypto$
DECLARE
  extension_schema text;
BEGIN
  SELECT namespace.nspname
    INTO extension_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = extension.extnamespace
    WHERE extension.extname = 'pgcrypto';

  IF extension_schema IS NULL THEN
    CREATE EXTENSION pgcrypto WITH SCHEMA wathaiqi_automation_crypto;
  ELSIF extension_schema <> 'wathaiqi_automation_crypto' THEN
    RAISE EXCEPTION
      'pgcrypto is already installed in schema %, expected wathaiqi_automation_crypto in this dedicated database',
      extension_schema;
  END IF;
END
$pgcrypto$;

CREATE TABLE IF NOT EXISTS wathaiqi_automation_private.receiver_secrets (
  key_id smallint PRIMARY KEY CHECK (key_id = 1),
  secret_bytes bytea NOT NULL CHECK (
    pg_catalog.octet_length(secret_bytes) BETWEEN 32 AND 128
  ),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE wathaiqi_automation_private.receiver_secrets
  OWNER TO wathaiqi_n8n_secret_owner;

CREATE SCHEMA IF NOT EXISTS wathaiqi_automation
  AUTHORIZATION wathaiqi_n8n_verifier_owner;
ALTER SCHEMA wathaiqi_automation
  OWNER TO wathaiqi_n8n_verifier_owner;

CREATE TABLE IF NOT EXISTS wathaiqi_automation.event_receipts (
  event_id uuid PRIMARY KEY,
  facility_id integer NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN (
      'credential.created',
      'credential.verification_changed',
      'credential.expiry_due',
      'credential.lifecycle_changed',
      'employee.lifecycle_changed',
      'employee.invitation_changed',
      'schedule.lifecycle_changed',
      'schedule_request.lifecycle_changed'
    )
  ),
  occurred_at timestamptz NOT NULL,
  event_digest text NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE wathaiqi_automation.event_receipts
  OWNER TO wathaiqi_n8n_verifier_owner;
ALTER TABLE wathaiqi_automation.event_receipts
  DROP CONSTRAINT IF EXISTS event_receipts_facility_id_check;
ALTER TABLE wathaiqi_automation.event_receipts
  DROP CONSTRAINT IF EXISTS event_receipts_facility_one_check;
ALTER TABLE wathaiqi_automation.event_receipts
  ADD CONSTRAINT event_receipts_facility_one_check
  CHECK (facility_id = 1) NOT VALID;
ALTER TABLE wathaiqi_automation.event_receipts
  VALIDATE CONSTRAINT event_receipts_facility_one_check;

CREATE INDEX IF NOT EXISTS event_receipts_received_at_idx
  ON wathaiqi_automation.event_receipts (received_at);

COMMENT ON TABLE wathaiqi_automation.event_receipts IS
  'Minimal HMAC-verified webhook receipt ledger; no document, employee, credential, OCR, contact, or authentication data.';

-- Remove the former trust boundary. It accepted caller-computed digests and
-- therefore must not remain executable after the DB-owned verifier is added.
DROP FUNCTION IF EXISTS wathaiqi_automation.claim_event_receipt(
  uuid,
  integer,
  text,
  timestamptz,
  text
);

CREATE OR REPLACE FUNCTION wathaiqi_automation.verify_and_claim_event_receipt(
  p_timestamp text,
  p_signature text,
  p_raw_body_base64 text
)
RETURNS TABLE(event_id uuid, receipt_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  secret_bytes bytea;
  raw_body bytea;
  raw_text text;
  envelope jsonb;
  data_object jsonb;
  parsed_event_id uuid;
  event_id_text text;
  event_type_text text;
  occurred_at_text text;
  parsed_occurred_at timestamptz;
  expected_signature bytea;
  provided_signature bytea;
  stable_event_digest text;
  existing_digest text;
  timestamp_seconds bigint;
  different integer := 0;
  key_count integer;
  byte_index integer;
BEGIN
  -- Exact header syntax. Any list folding, whitespace, comma, CR, or LF fails.
  IF p_timestamp IS NULL
    OR p_timestamp !~ '^[0-9]{10}$'
    OR p_signature IS NULL
    OR p_signature !~ '^sha256=[a-f0-9]{64}$'
  THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_signature'::text;
    RETURN;
  END IF;

  timestamp_seconds := p_timestamp::bigint;
  IF pg_catalog.abs(
    EXTRACT(epoch FROM pg_catalog.clock_timestamp())
      - timestamp_seconds::numeric
  ) > 300 THEN
    RETURN QUERY SELECT NULL::uuid, 'expired_signature'::text;
    RETURN;
  END IF;

  -- 4096 bytes require at most 5464 canonical Base64 characters.
  IF p_raw_body_base64 IS NULL
    OR pg_catalog.length(p_raw_body_base64) = 0
    OR pg_catalog.length(p_raw_body_base64) > 5464
    OR pg_catalog.length(p_raw_body_base64) % 4 <> 0
    OR p_raw_body_base64 !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
  THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END IF;

  BEGIN
    raw_body := pg_catalog.decode(p_raw_body_base64, 'base64');
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END;

  -- PostgreSQL wraps Base64 output at 76 characters. Remove only those LF
  -- separators before comparing with the canonical unwrapped Node.js input.
  IF pg_catalog.replace(
      pg_catalog.encode(raw_body, 'base64'),
      E'\n',
      ''
    ) <> p_raw_body_base64
    OR pg_catalog.octet_length(raw_body) NOT BETWEEN 1 AND 4096
  THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END IF;

  SELECT receiver.secret_bytes
    INTO secret_bytes
    FROM wathaiqi_automation_private.receiver_secrets AS receiver
    WHERE receiver.key_id = 1;

  IF secret_bytes IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, 'receiver_not_configured'::text;
    RETURN;
  END IF;

  expected_signature := wathaiqi_automation_crypto.hmac(
    pg_catalog.convert_to(p_timestamp || '.', 'UTF8') || raw_body,
    secret_bytes,
    'sha256'
  );
  provided_signature := pg_catalog.decode(
    pg_catalog.substring(p_signature, 8),
    'hex'
  );

  -- Best-effort fixed-work comparison: both inputs are exactly 32 bytes and
  -- every byte is XORed before the result is inspected. PL/pgSQL itself does
  -- not promise strict constant-time machine code, so network controls and
  -- rate limits remain required.
  different := 0;
  FOR byte_index IN 0..31 LOOP
    different := different | (
      pg_catalog.get_byte(expected_signature, byte_index)
        # pg_catalog.get_byte(provided_signature, byte_index)
    );
  END LOOP;
  IF different <> 0 THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_signature'::text;
    RETURN;
  END IF;

  BEGIN
    raw_text := pg_catalog.convert_from(raw_body, 'UTF8');
    envelope := raw_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END;

  IF pg_catalog.jsonb_typeof(envelope) <> 'object' THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO key_count
    FROM pg_catalog.jsonb_object_keys(envelope);
  IF key_count <> 5
    OR NOT (
      envelope ?& ARRAY['id', 'type', 'occurredAt', 'facilityId', 'data']::text[]
    )
    OR pg_catalog.jsonb_typeof(envelope -> 'id') <> 'string'
    OR pg_catalog.jsonb_typeof(envelope -> 'type') <> 'string'
    OR pg_catalog.jsonb_typeof(envelope -> 'occurredAt') <> 'string'
    OR pg_catalog.jsonb_typeof(envelope -> 'facilityId') <> 'number'
    OR pg_catalog.jsonb_typeof(envelope -> 'data') <> 'object'
  THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END IF;

  event_id_text := envelope ->> 'id';
  event_type_text := envelope ->> 'type';
  occurred_at_text := envelope ->> 'occurredAt';
  data_object := envelope -> 'data';

  IF event_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR event_type_text NOT IN (
      'credential.created',
      'credential.verification_changed',
      'credential.expiry_due',
      'credential.lifecycle_changed',
      'employee.lifecycle_changed',
      'employee.invitation_changed',
      'schedule.lifecycle_changed',
      'schedule_request.lifecycle_changed'
    )
  THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END IF;

  IF envelope ->> 'facilityId' <> '1' THEN
    RETURN QUERY SELECT NULL::uuid, 'facility_not_allowed'::text;
    RETURN;
  END IF;

  BEGIN
    parsed_event_id := event_id_text::uuid;
    parsed_occurred_at := occurred_at_text::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END;

  IF occurred_at_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR pg_catalog.to_char(
      parsed_occurred_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) <> occurred_at_text
  THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO key_count
    FROM pg_catalog.jsonb_object_keys(data_object);

  IF NOT COALESCE((
    (event_type_text = 'credential.created' AND key_count = 0)
    OR (
      event_type_text = 'credential.verification_changed'
      AND key_count = 1
      AND data_object ? 'isVerified'
      AND pg_catalog.jsonb_typeof(data_object -> 'isVerified') = 'boolean'
    )
    OR (
      event_type_text = 'credential.expiry_due'
      AND key_count = 1
      AND data_object ? 'thresholdDays'
      AND pg_catalog.jsonb_typeof(data_object -> 'thresholdDays') = 'number'
      AND data_object ->> 'thresholdDays' IN ('90', '60', '30', '15', '7', '1', '0')
    )
    OR (
      event_type_text = 'credential.lifecycle_changed'
      AND key_count = 1
      AND data_object ? 'change'
      AND pg_catalog.jsonb_typeof(data_object -> 'change') = 'string'
      AND data_object ->> 'change' IN ('updated', 'deleted')
    )
    OR (
      event_type_text = 'employee.lifecycle_changed'
      AND key_count = 1
      AND data_object ? 'change'
      AND pg_catalog.jsonb_typeof(data_object -> 'change') = 'string'
      AND data_object ->> 'change' IN (
        'created', 'updated', 'activated', 'deactivated'
      )
    )
    OR (
      event_type_text = 'employee.invitation_changed'
      AND key_count = 1
      AND data_object ? 'change'
      AND pg_catalog.jsonb_typeof(data_object -> 'change') = 'string'
      AND data_object ->> 'change' IN ('created', 'revoked', 'accepted')
    )
    OR (
      event_type_text = 'schedule.lifecycle_changed'
      AND key_count = 1
      AND data_object ? 'change'
      AND pg_catalog.jsonb_typeof(data_object -> 'change') = 'string'
      AND data_object ->> 'change' IN (
        'created', 'updated', 'published', 'reopened', 'cancelled'
      )
    )
    OR (
      event_type_text = 'schedule_request.lifecycle_changed'
      AND key_count = 1
      AND data_object ? 'change'
      AND pg_catalog.jsonb_typeof(data_object -> 'change') = 'string'
      AND data_object ->> 'change' IN (
        'submitted', 'withdrawn', 'approved', 'rejected', 'approval_revoked'
      )
    )
  ), false) THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_payload'::text;
    RETURN;
  END IF;

  -- The idempotency digest is intentionally independent of the signing key so
  -- an exact retry remains a duplicate after a coordinated HMAC-key rotation.
  stable_event_digest := pg_catalog.encode(
    wathaiqi_automation_crypto.digest(raw_body, 'sha256'),
    'hex'
  );

  INSERT INTO wathaiqi_automation.event_receipts (
    event_id,
    facility_id,
    event_type,
    occurred_at,
    event_digest
  )
  VALUES (
    parsed_event_id,
    1,
    event_type_text,
    parsed_occurred_at,
    stable_event_digest
  )
  ON CONFLICT ON CONSTRAINT event_receipts_pkey DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT parsed_event_id, 'inserted'::text;
    RETURN;
  END IF;

  SELECT receipt.event_digest
    INTO STRICT existing_digest
    FROM wathaiqi_automation.event_receipts AS receipt
    WHERE receipt.event_id = parsed_event_id;

  -- The digest is fixed-length lowercase hex. This comparison does not expose
  -- the HMAC secret; it only distinguishes an exact retry from UUID reuse.
  IF existing_digest = stable_event_digest THEN
    RETURN QUERY SELECT parsed_event_id, 'duplicate'::text;
  ELSE
    RETURN QUERY SELECT parsed_event_id, 'conflict'::text;
  END IF;
END
$function$;

ALTER FUNCTION wathaiqi_automation.verify_and_claim_event_receipt(
  text,
  text,
  text
) OWNER TO wathaiqi_n8n_verifier_owner;

REVOKE ALL ON SCHEMA wathaiqi_automation_private FROM PUBLIC;
REVOKE ALL ON SCHEMA wathaiqi_automation_private
  FROM wathaiqi_n8n_inbox_writer;
REVOKE ALL ON TABLE wathaiqi_automation_private.receiver_secrets FROM PUBLIC;
REVOKE ALL ON TABLE wathaiqi_automation_private.receiver_secrets
  FROM wathaiqi_n8n_inbox_writer;

REVOKE ALL ON SCHEMA wathaiqi_automation_crypto FROM PUBLIC;
REVOKE ALL ON SCHEMA wathaiqi_automation_crypto
  FROM wathaiqi_n8n_inbox_writer;
GRANT USAGE ON SCHEMA wathaiqi_automation_crypto
  TO wathaiqi_n8n_verifier_owner;

REVOKE ALL ON SCHEMA wathaiqi_automation FROM PUBLIC;
REVOKE ALL ON TABLE wathaiqi_automation.event_receipts FROM PUBLIC;
REVOKE ALL ON TABLE wathaiqi_automation.event_receipts
  FROM wathaiqi_n8n_inbox_writer;
REVOKE ALL ON FUNCTION wathaiqi_automation.verify_and_claim_event_receipt(
  text,
  text,
  text
) FROM PUBLIC;

GRANT USAGE ON SCHEMA wathaiqi_automation_private
  TO wathaiqi_n8n_verifier_owner;
GRANT SELECT ON TABLE wathaiqi_automation_private.receiver_secrets
  TO wathaiqi_n8n_verifier_owner;
GRANT USAGE ON SCHEMA wathaiqi_automation
  TO wathaiqi_n8n_inbox_writer;
GRANT EXECUTE ON FUNCTION wathaiqi_automation.verify_and_claim_event_receipt(
  text,
  text,
  text
) TO wathaiqi_n8n_inbox_writer;

-- The workflow login can connect to only this receiver DB and invoke the
-- wrapper through its writer role. The main n8n runtime and its offline
-- break-glass administrator receive no receiver-database access.
REVOKE ALL PRIVILEGES ON DATABASE wathaiqi_n8n_receipts
  FROM PUBLIC,
    wathaiqi_n8n,
    wathaiqi_n8n_app,
    wathaiqi_n8n_receiver_login,
    wathaiqi_n8n_receiver_operator;
GRANT CONNECT ON DATABASE wathaiqi_n8n_receipts
  TO wathaiqi_n8n_receiver_login, wathaiqi_n8n_receiver_operator;
REVOKE wathaiqi_n8n_inbox_writer
  FROM wathaiqi_n8n_receiver_login
  GRANTED BY CURRENT_USER;
GRANT wathaiqi_n8n_inbox_writer TO wathaiqi_n8n_receiver_login
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE
  GRANTED BY CURRENT_USER;
REVOKE wathaiqi_n8n_receipts_owner,
  wathaiqi_n8n_secret_owner,
  wathaiqi_n8n_verifier_owner,
  wathaiqi_n8n_receiver_operator,
  wathaiqi_n8n_app
  FROM wathaiqi_n8n_receiver_login;

-- PostgreSQL 16+ grants a CREATEROLE creator immutable ADMIN-only membership
-- (INHERIT FALSE, SET FALSE) in roles it creates. Remove only the additional
-- self-grants used during bootstrap; the remaining ADMIN-only rows do not make
-- object privileges usable unless the offline administrator explicitly grants
-- itself a new SET/INHERIT path. The managed administrator must never be
-- configured in the n8n service.
REVOKE wathaiqi_n8n_receipts_owner,
  wathaiqi_n8n_secret_owner,
  wathaiqi_n8n_verifier_owner,
  wathaiqi_n8n_inbox_writer,
  wathaiqi_n8n_receiver_operator,
  wathaiqi_n8n_receiver_login,
  wathaiqi_n8n_app
  FROM wathaiqi_n8n
  GRANTED BY CURRENT_USER;
REVOKE wathaiqi_n8n_receipts_owner,
  wathaiqi_n8n_secret_owner,
  wathaiqi_n8n_verifier_owner,
  wathaiqi_n8n_inbox_writer,
  wathaiqi_n8n_receiver_operator,
  wathaiqi_n8n_receiver_login
  FROM wathaiqi_n8n_app;

DO $postflight$
DECLARE
  main_database record;
  operator_membership_count integer;
  receiver_login_membership_count integer;
BEGIN
  IF pg_catalog.has_database_privilege(
    'wathaiqi_n8n',
    'wathaiqi_n8n_receipts',
    'CONNECT'
  ) OR pg_catalog.has_database_privilege(
    'wathaiqi_n8n_app',
    'wathaiqi_n8n_receipts',
    'CONNECT'
  ) OR pg_catalog.has_database_privilege(
    'wathaiqi_n8n_app',
    'wathaiqi_n8n_receipts',
    'CREATE'
  ) OR pg_catalog.has_database_privilege(
    'wathaiqi_n8n_receiver_login',
    'wathaiqi_n8n_receipts',
    'CREATE'
  ) OR pg_catalog.has_database_privilege(
    'wathaiqi_n8n_receiver_operator',
    'wathaiqi_n8n_receipts',
    'CREATE'
  ) THEN
    RAISE EXCEPTION
      'main n8n administrator or runtime can still connect to receiver database';
  END IF;

  IF NOT pg_catalog.has_database_privilege(
    'wathaiqi_n8n_receiver_login',
    'wathaiqi_n8n_receipts',
    'CONNECT'
  ) OR NOT pg_catalog.has_database_privilege(
    'wathaiqi_n8n_receiver_operator',
    'wathaiqi_n8n_receipts',
    'CONNECT'
  ) THEN
    RAISE EXCEPTION 'receiver LOGIN roles are missing CONNECT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_app'
  ) THEN
    RAISE EXCEPTION
      'role membership remains on the n8n application runtime';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n'
      AND granted_role.rolname IN (
        'wathaiqi_n8n_app',
        'wathaiqi_n8n_receipts_owner',
        'wathaiqi_n8n_secret_owner',
        'wathaiqi_n8n_verifier_owner',
        'wathaiqi_n8n_inbox_writer',
        'wathaiqi_n8n_receiver_operator',
        'wathaiqi_n8n_receiver_login'
      )
      AND (
        membership.inherit_option
        OR membership.set_option
        OR NOT membership.admin_option
      )
  ) THEN
    RAISE EXCEPTION
      'unsafe temporary break-glass membership remains after bootstrap';
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO operator_membership_count
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_receiver_operator'
      AND granted_role.rolname IN (
        'wathaiqi_n8n_receipts_owner',
        'wathaiqi_n8n_secret_owner',
        'wathaiqi_n8n_verifier_owner'
      )
      AND NOT membership.admin_option
      AND membership.set_option
      AND NOT membership.inherit_option;
  IF operator_membership_count <> 3 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_receiver_operator'
      AND (
        granted_role.rolname NOT IN (
          'wathaiqi_n8n_receipts_owner',
          'wathaiqi_n8n_secret_owner',
          'wathaiqi_n8n_verifier_owner'
        )
        OR membership.admin_option
        OR membership.inherit_option
        OR NOT membership.set_option
      )
  ) THEN
    RAISE EXCEPTION
      'receiver operator role-membership posture is unsafe after bootstrap';
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO receiver_login_membership_count
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_receiver_login'
      AND granted_role.rolname = 'wathaiqi_n8n_inbox_writer'
      AND NOT membership.admin_option
      AND membership.inherit_option
      AND NOT membership.set_option;
  IF receiver_login_membership_count <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'wathaiqi_n8n_receiver_login'
      AND (
        granted_role.rolname <> 'wathaiqi_n8n_inbox_writer'
        OR membership.admin_option
        OR NOT membership.inherit_option
        OR membership.set_option
      )
  ) THEN
    RAISE EXCEPTION
      'receiver workflow login role-membership posture is unsafe after bootstrap';
  END IF;

  -- Treat role membership as a bidirectional graph. An ACL allowlist is not a
  -- boundary if an unknown role can inherit a protected role, or if a protected
  -- NOLOGIN owner can SET/INHERIT an unrelated role.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE (
      granted_role.rolname IN (
        'wathaiqi_n8n',
        'wathaiqi_n8n_app',
        'wathaiqi_n8n_receipts_owner',
        'wathaiqi_n8n_secret_owner',
        'wathaiqi_n8n_verifier_owner',
        'wathaiqi_n8n_inbox_writer',
        'wathaiqi_n8n_receiver_operator',
        'wathaiqi_n8n_receiver_login'
      )
      OR member_role.rolname IN (
        'wathaiqi_n8n_app',
        'wathaiqi_n8n_receipts_owner',
        'wathaiqi_n8n_secret_owner',
        'wathaiqi_n8n_verifier_owner',
        'wathaiqi_n8n_inbox_writer',
        'wathaiqi_n8n_receiver_operator',
        'wathaiqi_n8n_receiver_login'
      )
    )
    AND NOT (
      (
        member_role.rolname = 'postgres'
        AND granted_role.rolname = 'wathaiqi_n8n'
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
      )
      OR (
        member_role.rolname = 'wathaiqi_n8n'
        AND granted_role.rolname IN (
          'wathaiqi_n8n_app',
          'wathaiqi_n8n_receipts_owner',
          'wathaiqi_n8n_secret_owner',
          'wathaiqi_n8n_verifier_owner',
          'wathaiqi_n8n_inbox_writer',
          'wathaiqi_n8n_receiver_operator',
          'wathaiqi_n8n_receiver_login'
        )
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
      )
      OR (
        member_role.rolname = 'wathaiqi_n8n_receiver_login'
        AND granted_role.rolname = 'wathaiqi_n8n_inbox_writer'
        AND NOT membership.admin_option
        AND membership.inherit_option
        AND NOT membership.set_option
      )
      OR (
        member_role.rolname = 'wathaiqi_n8n_receiver_operator'
        AND granted_role.rolname IN (
          'wathaiqi_n8n_receipts_owner',
          'wathaiqi_n8n_secret_owner',
          'wathaiqi_n8n_verifier_owner'
        )
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option
      )
    )
  ) THEN
    RAISE EXCEPTION
      'protected receiver role membership graph contains an unexpected edge';
  END IF;

  IF EXISTS (
    WITH boundary_grants AS (
      SELECT namespace.nspname AS boundary,
        COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee
        ON grantee.oid = privilege.grantee
      WHERE namespace.nspname IN (
        'wathaiqi_automation_private',
        'wathaiqi_automation_crypto',
        'wathaiqi_automation'
      )
      UNION ALL
      SELECT pg_catalog.concat(namespace.nspname, '.', object.relname),
        COALESCE(grantee.rolname, 'PUBLIC'),
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_catalog.pg_class AS object
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = object.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          object.relacl,
          pg_catalog.acldefault('r', object.relowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee
        ON grantee.oid = privilege.grantee
      WHERE (namespace.nspname, object.relname) IN (
        ('wathaiqi_automation_private', 'receiver_secrets'),
        ('wathaiqi_automation', 'event_receipts')
      )
      UNION ALL
      SELECT 'wathaiqi_automation.verify_and_claim_event_receipt',
        COALESCE(grantee.rolname, 'PUBLIC'),
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_catalog.pg_proc AS object
      JOIN pg_catalog.pg_namespace AS routine_namespace
        ON routine_namespace.oid = object.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          object.proacl,
          pg_catalog.acldefault('f', object.proowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee
        ON grantee.oid = privilege.grantee
      WHERE routine_namespace.nspname = 'wathaiqi_automation'
        AND object.proname = 'verify_and_claim_event_receipt'
        AND object.proargtypes = '25 25 25'::pg_catalog.oidvector
      UNION ALL
      SELECT 'wathaiqi_n8n_receipts',
        COALESCE(grantee.rolname, 'PUBLIC'),
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_catalog.pg_database AS database
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          database.datacl,
          pg_catalog.acldefault('d', database.datdba)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee
        ON grantee.oid = privilege.grantee
      WHERE database.datname = 'wathaiqi_n8n_receipts'
    )
    SELECT 1
    FROM boundary_grants AS grant_row
    WHERE NOT (
      (grant_row.boundary = 'wathaiqi_automation_private' AND (
        grant_row.grantee = 'wathaiqi_n8n_secret_owner'
        OR (
          grant_row.grantee = 'wathaiqi_n8n_verifier_owner'
          AND grant_row.privilege_type = 'USAGE'
          AND NOT grant_row.is_grantable
        )
      ))
      OR (grant_row.boundary = 'wathaiqi_automation_crypto'
        AND grant_row.grantee = 'wathaiqi_n8n_verifier_owner')
      OR (grant_row.boundary = 'wathaiqi_automation' AND (
        grant_row.grantee = 'wathaiqi_n8n_verifier_owner'
        OR (
          grant_row.grantee = 'wathaiqi_n8n_inbox_writer'
          AND grant_row.privilege_type = 'USAGE'
          AND NOT grant_row.is_grantable
        )
      ))
      OR (grant_row.boundary =
        'wathaiqi_automation_private.receiver_secrets' AND (
          grant_row.grantee = 'wathaiqi_n8n_secret_owner'
          OR (
            grant_row.grantee = 'wathaiqi_n8n_verifier_owner'
            AND grant_row.privilege_type = 'SELECT'
            AND NOT grant_row.is_grantable
          )
        ))
      OR (grant_row.boundary = 'wathaiqi_automation.event_receipts'
        AND grant_row.grantee = 'wathaiqi_n8n_verifier_owner')
      OR (grant_row.boundary =
        'wathaiqi_automation.verify_and_claim_event_receipt' AND (
          grant_row.grantee = 'wathaiqi_n8n_verifier_owner'
          OR (
            grant_row.grantee = 'wathaiqi_n8n_inbox_writer'
            AND grant_row.privilege_type = 'EXECUTE'
            AND NOT grant_row.is_grantable
          )
        ))
      OR (grant_row.boundary = 'wathaiqi_n8n_receipts' AND (
        grant_row.grantee = 'wathaiqi_n8n_receipts_owner'
        OR (
          grant_row.grantee IN (
            'wathaiqi_n8n_receiver_login',
            'wathaiqi_n8n_receiver_operator'
          )
          AND grant_row.privilege_type = 'CONNECT'
          AND NOT grant_row.is_grantable
        )
      ))
    )
  ) THEN
    RAISE EXCEPTION
      'receiver boundary has an unexpected grantee, privilege, or grant option';
  END IF;

  FOR main_database IN
    SELECT database.datname
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = database.datdba
    WHERE owner_role.rolname = 'wathaiqi_n8n'
      AND database.datname <> 'wathaiqi_n8n_receipts'
      AND database.datallowconn
      AND NOT database.datistemplate
      AND pg_catalog.has_database_privilege(
        'wathaiqi_n8n_app', database.datname, 'CREATE'
      )
      AND pg_catalog.has_database_privilege(
        'wathaiqi_n8n_app', database.datname, 'TEMPORARY'
      )
  LOOP
    IF NOT pg_catalog.has_database_privilege(
      'wathaiqi_n8n_app', main_database.datname, 'CONNECT'
    ) OR NOT pg_catalog.has_database_privilege(
      'wathaiqi_n8n', main_database.datname, 'CONNECT'
    ) OR pg_catalog.has_database_privilege(
      'wathaiqi_n8n_receiver_login', main_database.datname, 'CONNECT'
    ) OR pg_catalog.has_database_privilege(
      'wathaiqi_n8n_receiver_operator', main_database.datname, 'CONNECT'
    ) OR pg_catalog.has_database_privilege(
      'wathaiqi_n8n_receiver_login', main_database.datname, 'CREATE'
    ) OR pg_catalog.has_database_privilege(
      'wathaiqi_n8n_receiver_operator', main_database.datname, 'CREATE'
    ) THEN
      RAISE EXCEPTION
        'unsafe CONNECT matrix for main n8n database %',
        main_database.datname;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = database.datdba
    WHERE database.datallowconn
      AND NOT database.datistemplate
      AND database.datname <> 'wathaiqi_n8n_receipts'
      AND NOT (
        owner_role.rolname = 'wathaiqi_n8n'
        AND pg_catalog.has_database_privilege(
          'wathaiqi_n8n_app', database.datname, 'CONNECT'
        )
        AND pg_catalog.has_database_privilege(
          'wathaiqi_n8n_app', database.datname, 'CREATE'
        )
        AND pg_catalog.has_database_privilege(
          'wathaiqi_n8n_app', database.datname, 'TEMPORARY'
        )
      )
      AND NOT (
        database.datname = 'postgres'
        AND owner_role.rolname = 'postgres'
      )
  ) THEN
    RAISE EXCEPTION
      'unexpected connectable database exists outside the reviewed allowlist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = database.datdba
    WHERE database.datallowconn
      AND NOT database.datistemplate
      AND database.datname = 'postgres'
      AND owner_role.rolname = 'postgres'
      AND (
        pg_catalog.has_database_privilege(
          'wathaiqi_n8n_app', database.datname, 'CREATE'
        )
        OR pg_catalog.has_database_privilege(
          'wathaiqi_n8n_receiver_login', database.datname, 'CREATE'
        )
        OR pg_catalog.has_database_privilege(
          'wathaiqi_n8n_receiver_operator', database.datname, 'CREATE'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'runtime role has CREATE on provider maintenance database';
  END IF;
END
$postflight$;

COMMIT;

-- Parameterized operator follow-up (never paste a secret into this file):
--
--   BEGIN;
--   SET LOCAL ROLE wathaiqi_n8n_secret_owner;
--   INSERT INTO wathaiqi_automation_private.receiver_secrets (
--     key_id, secret_bytes, updated_at
--   )
--   VALUES (1, pg_catalog.decode($1, 'base64'), pg_catalog.clock_timestamp())
--   ON CONFLICT (key_id) DO UPDATE
--     SET secret_bytes = EXCLUDED.secret_bytes,
--         updated_at = EXCLUDED.updated_at;
--   COMMIT;
--
-- Bind $1 through a database driver to the SAME canonical Base64 value used by
-- AUTOMATION_WEBHOOK_SECRET. Execute with the break-glass receiver operator,
-- never the n8n service or workflow login.
-- The CHECK constraint rejects decoded keys shorter than 32 or longer than 128
-- bytes. Rotate only during a coordinated sender/receiver maintenance window.
--
-- The bootstrap creates wathaiqi_n8n_receiver_login separately with a
-- secret-manager password. Do not reuse the wathaiqi_n8n_app credential.
--
-- Retention must run as the database owner or a separate maintenance role;
-- the workflow writer intentionally has no table, secret, DDL, or role rights.
-- A reviewed maintenance job may delete receipts older than 30 days:
--   DELETE FROM wathaiqi_automation.event_receipts
--   WHERE received_at < pg_catalog.clock_timestamp() - interval '30 days';
