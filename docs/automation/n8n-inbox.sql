-- Run once as the owner of a DEDICATED n8n automation database.
-- This is not an application migration and must never run against the Health
-- Credential Hub application database.

BEGIN;

CREATE SCHEMA IF NOT EXISTS wathaiqi_automation;

CREATE TABLE IF NOT EXISTS wathaiqi_automation.event_receipts (
  event_id uuid PRIMARY KEY,
  facility_id integer NOT NULL CHECK (facility_id > 0),
  event_type text NOT NULL CHECK (
    event_type IN (
      'credential.created',
      'credential.verification_changed',
      'credential.expiry_due'
    )
  ),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS event_receipts_received_at_idx
  ON wathaiqi_automation.event_receipts (received_at);

COMMENT ON TABLE wathaiqi_automation.event_receipts IS
  'Minimal HMAC-verified webhook receipt ledger; no document, employee, credential, OCR, contact, or authentication data.';

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'wathaiqi_n8n_inbox_writer'
  ) THEN
    CREATE ROLE wathaiqi_n8n_inbox_writer NOLOGIN;
  END IF;
END
$role$;

REVOKE ALL ON SCHEMA wathaiqi_automation FROM PUBLIC;
REVOKE ALL ON TABLE wathaiqi_automation.event_receipts FROM PUBLIC;
GRANT USAGE ON SCHEMA wathaiqi_automation TO wathaiqi_n8n_inbox_writer;
GRANT INSERT (event_id, facility_id, event_type, occurred_at)
  ON wathaiqi_automation.event_receipts
  TO wathaiqi_n8n_inbox_writer;
-- PostgreSQL may read the conflict target while evaluating ON CONFLICT.
-- This exposes only opaque UUIDs, not the remaining receipt metadata.
GRANT SELECT (event_id)
  ON wathaiqi_automation.event_receipts
  TO wathaiqi_n8n_inbox_writer;

COMMIT;

-- Operator follow-up (do not put a password in this file):
--   CREATE ROLE <dedicated_login> LOGIN PASSWORD '<from secret manager>';
--   GRANT wathaiqi_n8n_inbox_writer TO <dedicated_login>;
--
-- Retention must run as the database owner or a separate maintenance role;
-- the workflow writer intentionally has no UPDATE, DELETE, DDL, or role rights.
-- A reviewed maintenance job may delete receipts older than 30 days:
--   DELETE FROM wathaiqi_automation.event_receipts
--   WHERE received_at < clock_timestamp() - interval '30 days';
