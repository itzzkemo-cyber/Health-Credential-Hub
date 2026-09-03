import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "..", "..");
const workflowPath = path.join(
  directory,
  "wathaiqi-n8n-receiver.workflow.json",
);
const [
  workflowText,
  inboxSql,
  n8nEnv,
  automationSchema,
  automationReadme,
  integrations,
  provisionScript,
  inspectionScript,
] = await Promise.all([
  readFile(workflowPath, "utf8"),
  readFile(path.join(directory, "n8n-inbox.sql"), "utf8"),
  readFile(path.join(directory, "n8n.env.example"), "utf8"),
  readFile(
    path.join(
      repositoryRoot,
      "lib",
      "db",
      "src",
      "schema",
      "automation-outbox.ts",
    ),
    "utf8",
  ),
  readFile(path.join(directory, "README.md"), "utf8"),
  readFile(path.join(repositoryRoot, "docs", "INTEGRATIONS.md"), "utf8"),
  readFile(path.join(repositoryRoot, ".local", "provision-n8n-db.cjs"), "utf8"),
  readFile(path.join(repositoryRoot, ".local", "inspect-n8n-bootstrap.cjs"), "utf8"),
]);
const workflow = JSON.parse(workflowText);
const node = (name) => {
  const found = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(found, "missing workflow node: " + name);
  return found;
};
const quotedValues = (source) =>
  [...source.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
const sourceArray = (source, name) => {
  const pattern =
    "(?:export\\s+)?const\\s+" +
    name +
    "\\s*=\\s*(?:Object\\.freeze\\()?\\[([\\s\\S]*?)\\](?:\\))?(?:\\s+as\\s+const)?;";
  const block = source.match(new RegExp(pattern))?.[1];
  assert.ok(block, "missing array contract: " + name);
  return quotedValues(block);
};
const targets = (from, branch = 0) =>
  (workflow.connections[from]?.main?.[branch] ?? []).map((edge) => edge.node);

let checks = 0;
async function check(name, callback) {
  await callback();
  checks += 1;
  console.log("ok " + checks + " - " + name);
}

await check(
  "workflow is importable but inactive and retains no executions",
  () => {
    assert.equal(workflow.active, false);
    assert.equal(workflow.settings.saveDataErrorExecution, "none");
    assert.equal(workflow.settings.saveDataSuccessExecution, "none");
    assert.equal(workflow.settings.saveManualExecutions, false);
    assert.deepEqual(workflow.pinData, {});
  },
);

await check(
  "webhook preserves the exact raw body and waits for an explicit response",
  () => {
    const webhook = node("Receive exact raw body");
    assert.equal(webhook.type, "n8n-nodes-base.webhook");
    assert.equal(webhook.parameters.httpMethod, "POST");
    assert.equal(webhook.parameters.responseMode, "responseNode");
    assert.equal(webhook.parameters.options.rawBody, true);
  },
);

await check(
  "template contains no Crypto node, embedded credential, or outbound provider",
  () => {
    const allowedNodeTypes = new Set([
      "n8n-nodes-base.webhook",
      "n8n-nodes-base.code",
      "n8n-nodes-base.if",
      "n8n-nodes-base.postgres",
      "n8n-nodes-base.respondToWebhook",
      "n8n-nodes-base.stickyNote",
    ]);
    for (const candidate of workflow.nodes) {
      assert.ok(allowedNodeTypes.has(candidate.type), candidate.type);
      assert.equal(candidate.credentials, undefined);
    }
    assert.equal(workflowText.includes("n8n-nodes-base.crypto"), false);
    assert.equal(workflowText.includes("n8n-nodes-base.httpRequest"), false);
    assert.equal(workflowText.includes("https://"), false);
    assert.doesNotMatch(workflowText, /Compute expected HMAC/);
    assert.doesNotMatch(workflowText, /Compute stable event HMAC/);
  },
);

await check(
  "only a shape-valid request can reach the DB verifier",
  () => {
    assert.deepEqual(targets("Receive exact raw body"), [
      "Validate exact request",
    ]);
    assert.deepEqual(targets("Validate exact request"), [
      "Request shape valid?",
    ]);
    assert.deepEqual(targets("Request shape valid?", 0), [
      "Verify and claim in PostgreSQL",
    ]);
    assert.deepEqual(targets("Request shape valid?", 1), [
      "Reject malformed request",
    ]);
    assert.deepEqual(targets("Verify and claim in PostgreSQL"), [
      "Map safe receipt response",
    ]);
    assert.deepEqual(targets("Map safe receipt response"), [
      "Return verified result",
    ]);
    const postgresNodes = workflow.nodes.filter(
      (candidate) => candidate.type === "n8n-nodes-base.postgres",
    );
    assert.deepEqual(
      postgresNodes.map((candidate) => candidate.name),
      ["Verify and claim in PostgreSQL"],
    );
  },
);

const validateNode = node("Validate exact request");
const validateCode = validateNode.parameters.jsCode;
const mapCode = node("Map safe receipt response").parameters.jsCode;

await check("facility, body, and header controls are fail-closed", () => {
  assert.match(
    validateCode,
    /const ALLOWED_FACILITY_IDS = Object\.freeze\(\[1\]\);/,
  );
  assert.match(validateCode, /MAX_BODY_BYTES = 4096/);
  assert.match(validateCode, /Array\.isArray\(value\)/);
  assert.match(validateCode, /\/\[,\\r\\n\]\//);
  assert.match(validateCode, /matches\.length !== 1/);
  assert.match(n8nEnv, /^N8N_IMAGE=n8nio\/n8n:1\.123\.76$/m);
  assert.doesNotMatch(n8nEnv, /^N8N_IMAGE=.*:latest$/m);
  assert.match(n8nEnv, /^EXECUTIONS_DATA_SAVE_ON_ERROR=none$/m);
  assert.match(n8nEnv, /^EXECUTIONS_DATA_SAVE_ON_SUCCESS=none$/m);
});

const contractArrays = [
  "AUTOMATION_EVENT_TYPES",
  "CREDENTIAL_LIFECYCLE_CHANGES",
  "EMPLOYEE_LIFECYCLE_CHANGES",
  "EMPLOYEE_INVITATION_CHANGES",
  "SCHEDULE_LIFECYCLE_CHANGES",
  "SCHEDULE_REQUEST_LIFECYCLE_CHANGES",
];
await check(
  "receiver event and change enums match the application contract",
  () => {
    for (const name of contractArrays) {
      assert.deepEqual(
        sourceArray(validateCode, name.replace("AUTOMATION_", "")),
        sourceArray(automationSchema, name),
        name,
      );
    }
  },
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runCode(code, json, rawBody) {
  const fn = new AsyncFunction("$input", code);
  const input = {
    first: () => ({
      json,
      ...(rawBody
        ? { binary: { data: { mimeType: "application/json" } } }
        : {}),
    }),
  };
  return fn.call(
    {
      helpers: {
        getBinaryDataBuffer: async () => rawBody,
      },
    },
    input,
  );
}

const timestamp = String(Math.floor(Date.now() / 1000));
const signature = "sha256=" + "a".repeat(64);
const baseEnvelope = {
  id: "7c0cd5f3-d646-4b87-b20e-70d5d2f42591",
  occurredAt: new Date().toISOString(),
  facilityId: 1,
};
function requestFor(envelope, headerOverrides = {}) {
  const rawBody = Buffer.from(JSON.stringify(envelope), "utf8");
  return {
    rawBody,
    json: {
      headers: {
        "content-type": "application/json",
        "idempotency-key": envelope.id,
        "x-health-credential-event-id": envelope.id,
        "x-health-credential-event-type": envelope.type,
        "x-health-credential-timestamp": timestamp,
        "x-health-credential-signature": signature,
        ...headerOverrides,
      },
    },
  };
}

const validEvents = [
  { ...baseEnvelope, type: "credential.created", data: {} },
  {
    ...baseEnvelope,
    type: "credential.verification_changed",
    data: { isVerified: true },
  },
  {
    ...baseEnvelope,
    type: "credential.expiry_due",
    data: { thresholdDays: 30 },
  },
  ...["updated", "deleted"].map((change) => ({
    ...baseEnvelope,
    type: "credential.lifecycle_changed",
    data: { change },
  })),
  ...["created", "updated", "activated", "deactivated"].map((change) => ({
    ...baseEnvelope,
    type: "employee.lifecycle_changed",
    data: { change },
  })),
  ...["created", "revoked", "accepted"].map((change) => ({
    ...baseEnvelope,
    type: "employee.invitation_changed",
    data: { change },
  })),
  ...["created", "updated", "published", "reopened", "cancelled"].map(
    (change) => ({
      ...baseEnvelope,
      type: "schedule.lifecycle_changed",
      data: { change },
    }),
  ),
  ...["submitted", "withdrawn", "approved", "rejected", "approval_revoked"].map(
    (change) => ({
      ...baseEnvelope,
      type: "schedule_request.lifecycle_changed",
      data: { change },
    }),
  ),
];

await check("every minimized lifecycle event shape is accepted", async () => {
  for (const event of validEvents) {
    const request = requestFor(event);
    const [prepared] = await runCode(
      validateCode,
      request.json,
      request.rawBody,
    );
    assert.deepEqual(Object.keys(prepared.json).sort(), [
      "precheckOk",
      "rawBodyBase64",
      "signature",
      "timestamp",
    ]);
    assert.equal(prepared.json.precheckOk, true, JSON.stringify(event));
    assert.equal(
      Buffer.from(prepared.json.rawBodyBase64, "base64").equals(request.rawBody),
      true,
    );
  }
});

await check(
  "duplicate, folded, comma, and CRLF security headers are rejected",
  async () => {
    const event = validEvents[0];
    const cases = [
      requestFor(event, {
        "x-health-credential-signature": [signature, signature],
      }),
      requestFor(event, {
        "x-health-credential-signature": signature + "," + signature,
      }),
      requestFor(event, {
        "x-health-credential-signature": signature + "\r\nx-added: true",
      }),
      requestFor(event, {
        "Content-Type": "application/json",
      }),
    ];
    for (const request of cases) {
      const [result] = await runCode(
        validateCode,
        request.json,
        request.rawBody,
      );
      assert.equal(result.json.precheckOk, false);
      assert.equal(result.json.safeReason, "invalid_headers");
    }
  },
);

await check(
  "expanded payloads, invalid UTF-8, oversized bodies, and other facilities fail",
  async () => {
    const invalidEvent = {
      ...validEvents[0],
      data: { credentialId: 42 },
    };
    const invalidRequest = requestFor(invalidEvent);
    const [invalidResult] = await runCode(
      validateCode,
      invalidRequest.json,
      invalidRequest.rawBody,
    );
    assert.equal(invalidResult.json.safeReason, "invalid_payload");

    const otherFacility = { ...validEvents[0], facilityId: 2 };
    const otherRequest = requestFor(otherFacility);
    const [otherResult] = await runCode(
      validateCode,
      otherRequest.json,
      otherRequest.rawBody,
    );
    assert.equal(otherResult.json.statusCode, 403);
    assert.equal(otherResult.json.safeReason, "facility_not_allowed");

    const validHeaders = requestFor(validEvents[0]).json;
    const [utf8Result] = await runCode(
      validateCode,
      validHeaders,
      Buffer.from([0xc3, 0x28]),
    );
    assert.equal(utf8Result.json.safeReason, "invalid_utf8");

    const [largeResult] = await runCode(
      validateCode,
      validHeaders,
      Buffer.alloc(4097, 0x61),
    );
    assert.equal(largeResult.json.safeReason, "invalid_body_size");
  },
);

await check(
  "PostgreSQL node passes only timestamp, signature, and exact body Base64",
  () => {
    const postgres = node("Verify and claim in PostgreSQL");
    const query = postgres.parameters.query;
    assert.match(
      query,
      /wathaiqi_automation\.verify_and_claim_event_receipt\([\s\S]*\$1::text[\s\S]*\$2::text[\s\S]*\$3::text/,
    );
    assert.equal(query.includes("$json"), false);
    assert.equal(
      postgres.parameters.options.queryReplacement.split(",").length,
      3,
    );
    assert.match(
      postgres.parameters.options.queryReplacement,
      /^\=\{\{ \$json\.timestamp \}\},=\{\{ \$json\.signature \}\},=\{\{ \$json\.rawBodyBase64 \}\}$/,
    );
  },
);

await check(
  "main n8n objects move to a limited runtime while provider admin stays offline",
  () => {
    assert.match(
      automationReadme,
      /CREATE ROLE wathaiqi_n8n_app[\s\S]*?LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT[\s\S]*?NOBYPASSRLS;/,
    );
    assert.match(
      automationReadme,
      /Keep `wathaiqi_n8n` as the main database owner/i,
    );
    assert.match(
      automationReadme,
      /do not use `REASSIGN OWNED`/i,
    );
    assert.doesNotMatch(
      automationReadme,
      /^\s*REASSIGN OWNED BY wathaiqi_n8n TO wathaiqi_n8n_app;/m,
    );
    assert.doesNotMatch(
      automationReadme,
      /ALTER DATABASE "<actual-main-n8n-database>"[\s\S]*?OWNER TO wathaiqi_n8n_app;/,
    );
    assert.match(
      automationReadme,
      /GRANT CONNECT, CREATE, TEMPORARY[\s\S]*?ON DATABASE "<actual-main-n8n-database>" TO wathaiqi_n8n_app;/,
    );
    assert.match(
      automationReadme,
      /ALTER SCHEMA public OWNER TO wathaiqi_n8n_app;/,
    );
    assert.match(
      automationReadme,
      /must\s+never appear in the n8n service\s+environment or workflow credential store/i,
    );
    assert.match(n8nEnv, /^DB_POSTGRESDB_USER=wathaiqi_n8n_app$/m);
    assert.match(n8nEnv, /^DB_POSTGRESDB_SCHEMA=public$/m);
    assert.doesNotMatch(n8nEnv, /^DB_POSTGRESDB_USER=wathaiqi_n8n$/m);
    assert.match(n8nEnv, /^N8N_COMMUNITY_PACKAGES_ENABLED=false$/m);
    assert.match(
      inboxSql,
      /current_setting\('server_version_num'\)::integer < 160000/,
    );
    assert.match(
      inboxSql,
      /'wathaiqi_n8n_app'[\s\S]*?role_record\.rolcreatedb[\s\S]*?role_record\.rolcreaterole/,
    );
    assert.match(
      inboxSql,
      /owner_role\.rolname = 'wathaiqi_n8n'[\s\S]*?'wathaiqi_n8n_app', database\.datname, 'CREATE'[\s\S]*?'wathaiqi_n8n_app', database\.datname, 'TEMPORARY'/,
    );
    assert.doesNotMatch(
      inboxSql,
      /ALTER ROLE\s+wathaiqi_n8n\s+(?:NO)?CREATEROLE/,
    );
    assert.doesNotMatch(provisionScript, /REASSIGN OWNED/);
    assert.doesNotMatch(
      provisionScript,
      /ALTER DATABASE[\s\S]*?OWNER TO[\s\S]*?wathaiqi_n8n_app/,
    );
    assert.doesNotMatch(
      provisionScript,
      /(?:CREATE|ALTER) ROLE \$\{APP_ROLE\}/,
    );
    assert.match(
      provisionScript,
      /database\.rows\[0\]\?\.owner !== ADMIN_ROLE/,
    );
    assert.match(provisionScript, /namespace\.nspname = 'public'/);
    assert.match(inspectionScript, /publicForeignOwnerCounts/);
    assert.match(
      inboxSql,
      /GRANTED BY CURRENT_USER;/,
    );
    assert.match(
      inboxSql,
      /member_role\.rolname = 'wathaiqi_n8n'[\s\S]*?membership\.inherit_option[\s\S]*?membership\.set_option[\s\S]*?NOT membership\.admin_option/,
    );
    assert.match(
      inboxSql,
      /member_role\.rolname = 'wathaiqi_n8n_app'[\s\S]*?'wathaiqi_n8n_receipts_owner'[\s\S]*?'wathaiqi_n8n_receiver_login'/,
    );
  },
);

await check(
  "receiver DB separates NOLOGIN owners and denies runtime secret/table access",
  () => {
    assert.match(
      automationReadme,
      /CREATE ROLE wathaiqi_n8n_receipts_owner[\s\S]*?NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT[\s\S]*?NOBYPASSRLS;/,
    );
    assert.match(
      automationReadme,
      /CREATE ROLE wathaiqi_n8n_secret_owner[\s\S]*?NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT[\s\S]*?NOBYPASSRLS;/,
    );
    assert.match(
      automationReadme,
      /CREATE ROLE wathaiqi_n8n_verifier_owner[\s\S]*?NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT[\s\S]*?NOBYPASSRLS;/,
    );
    assert.match(
      automationReadme,
      /CREATE ROLE wathaiqi_n8n_receiver_operator[\s\S]*?LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT[\s\S]*?NOBYPASSRLS;/,
    );
    assert.match(
      automationReadme,
      /TO wathaiqi_n8n_receiver_operator[\s\S]*?WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;/,
    );
    assert.doesNotMatch(workflowText, /wathaiqi_n8n_receiver_operator/);
    assert.match(
      inboxSql,
      /current_database\(\) <> 'wathaiqi_n8n_receipts'/,
    );
    assert.match(
      inboxSql,
      /actual_database_owner <> 'wathaiqi_n8n_receipts_owner'/,
    );
    assert.match(
      inboxSql,
      /current_user <> 'wathaiqi_n8n'[\s\S]*?session_user <> 'wathaiqi_n8n'/,
    );
    assert.match(
      inboxSql,
      /CREATE SCHEMA IF NOT EXISTS wathaiqi_automation_private[\s\S]*?AUTHORIZATION wathaiqi_n8n_secret_owner/,
    );
    assert.match(
      inboxSql,
      /ALTER TABLE wathaiqi_automation_private\.receiver_secrets[\s\S]*?OWNER TO wathaiqi_n8n_secret_owner/,
    );
    assert.match(
      inboxSql,
      /ALTER FUNCTION wathaiqi_automation\.verify_and_claim_event_receipt\([\s\S]*?\) OWNER TO wathaiqi_n8n_verifier_owner/,
    );
    assert.match(
      inboxSql,
      /GRANT SELECT ON TABLE wathaiqi_automation_private\.receiver_secrets[\s\S]*?TO wathaiqi_n8n_verifier_owner/,
    );
    assert.doesNotMatch(
      inboxSql,
      /GRANT SELECT ON TABLE wathaiqi_automation_private\.receiver_secrets[^;]*TO wathaiqi_n8n_inbox_writer;/,
    );
    assert.doesNotMatch(
      inboxSql,
      /GRANT (?:INSERT|SELECT|UPDATE|DELETE|ALL) ON TABLE wathaiqi_automation\.event_receipts[^;]*TO wathaiqi_n8n_inbox_writer;/,
    );
    assert.match(
      inboxSql,
      /GRANT EXECUTE ON FUNCTION wathaiqi_automation\.verify_and_claim_event_receipt\([\s\S]*?\) TO wathaiqi_n8n_inbox_writer/,
    );
    assert.match(
      inboxSql,
      /DROP FUNCTION IF EXISTS wathaiqi_automation\.claim_event_receipt/,
    );
    assert.match(
      inboxSql,
      /REVOKE ALL PRIVILEGES ON DATABASE wathaiqi_n8n_receipts[\s\S]*?FROM PUBLIC,[\s\S]*?wathaiqi_n8n,[\s\S]*?wathaiqi_n8n_app,[\s\S]*?wathaiqi_n8n_receiver_login,[\s\S]*?wathaiqi_n8n_receiver_operator;/,
    );
    assert.match(
      inboxSql,
      /GRANT CONNECT ON DATABASE wathaiqi_n8n_receipts[\s\S]*?TO wathaiqi_n8n_receiver_login, wathaiqi_n8n_receiver_operator;/,
    );
    assert.match(
      inboxSql,
      /membership\.set_option[\s\S]*?NOT membership\.inherit_option/,
    );
    assert.match(
      inboxSql,
      /WHERE role\.rolname IN \([\s\S]*?'wathaiqi_n8n_receiver_operator',[\s\S]*?'wathaiqi_n8n_receiver_login'[\s\S]*?\)[\s\S]*?role_record\.rolinherit/,
    );
    assert.match(
      inboxSql,
      /has_database_privilege\([\s\S]*?'wathaiqi_n8n_receiver_login'[\s\S]*?'CONNECT'[\s\S]*?\)/,
    );
    assert.match(
      automationReadme,
      /REVOKE ALL PRIVILEGES ON DATABASE "<actual-main-n8n-database>"[\s\S]*?FROM PUBLIC, wathaiqi_n8n_app, wathaiqi_n8n_receiver_login,[\s\S]*?wathaiqi_n8n_receiver_operator;/,
    );
    assert.match(
      inboxSql,
      /GRANT wathaiqi_n8n_inbox_writer TO wathaiqi_n8n_receiver_login[\s\S]*?WITH ADMIN FALSE, INHERIT TRUE, SET FALSE[\s\S]*?GRANTED BY CURRENT_USER;/,
    );
    assert.match(
      inboxSql,
      /REVOKE wathaiqi_n8n_inbox_writer[\s\S]*?FROM wathaiqi_n8n_receiver_login[\s\S]*?GRANTED BY CURRENT_USER;[\s\S]*?GRANT wathaiqi_n8n_inbox_writer TO wathaiqi_n8n_receiver_login[\s\S]*?SET FALSE[\s\S]*?GRANTED BY CURRENT_USER;/,
    );
    assert.doesNotMatch(
      inboxSql,
      /ALTER ROLE wathaiqi_n8n NOCREATEROLE NOCREATEDB;/,
    );
    assert.match(
      inboxSql,
      /REVOKE wathaiqi_n8n_receipts_owner,[\s\S]*?wathaiqi_n8n_inbox_writer,[\s\S]*?wathaiqi_n8n_receiver_operator,[\s\S]*?wathaiqi_n8n_receiver_login,[\s\S]*?wathaiqi_n8n_app[\s\S]*?FROM wathaiqi_n8n[\s\S]*?GRANTED BY CURRENT_USER;/,
    );
    assert.match(
      inboxSql,
      /database\.datallowconn[\s\S]*?NOT database\.datistemplate[\s\S]*?unexpected connectable database/,
    );
    assert.match(
      inboxSql,
      /database_record\.datname = 'postgres'[\s\S]*?database_record\.owner_name = 'postgres'[\s\S]*?runtime role has CREATE on provider maintenance database/,
    );
    assert.match(inboxSql, /pg_catalog\.aclexplode\(/);
    assert.match(
      inboxSql,
      /receiver boundary has an unexpected grantee, privilege, or grant option/,
    );
    assert.match(
      inboxSql,
      /receiver_login_membership_count <> 1[\s\S]*?granted_role\.rolname <> 'wathaiqi_n8n_inbox_writer'/,
    );
    assert.match(
      inboxSql,
      /member_role\.rolname = 'wathaiqi_n8n_app'[\s\S]*?role membership remains on the n8n application runtime/,
    );
    assert.match(
      inboxSql,
      /Treat role membership as a bidirectional graph[\s\S]*?granted_role\.rolname IN[\s\S]*?OR member_role\.rolname IN[\s\S]*?protected receiver role membership graph contains an unexpected edge/,
    );
    assert.match(
      inboxSql,
      /member_role\.rolname = 'postgres'[\s\S]*?granted_role\.rolname = 'wathaiqi_n8n'[\s\S]*?membership\.admin_option[\s\S]*?NOT membership\.inherit_option[\s\S]*?NOT membership\.set_option/,
    );
  },
);

await check(
  "DB verifier owns HMAC, replay, payload, tenant, and idempotency checks",
  () => {
    assert.match(
      inboxSql,
      /CREATE OR REPLACE FUNCTION wathaiqi_automation\.verify_and_claim_event_receipt/,
    );
    assert.match(inboxSql, /SECURITY DEFINER/);
    assert.match(inboxSql, /SET search_path = pg_catalog/);
    assert.match(inboxSql, /wathaiqi_automation_crypto\.hmac\(/);
    assert.equal(
      [...inboxSql.matchAll(/wathaiqi_automation_crypto\.hmac\(/g)].length,
      1,
    );
    assert.match(inboxSql, /FOR byte_index IN 0\.\.31 LOOP/);
    assert.match(inboxSql, /pg_catalog\.substring\(p_signature, 8\)/);
    assert.match(
      inboxSql,
      /get_byte\(expected_signature, byte_index\)[\s\S]*?# pg_catalog\.get_byte\(provided_signature, byte_index\)/,
    );
    assert.match(inboxSql, /\) > 300 THEN/);
    assert.match(inboxSql, /octet_length\(raw_body\) NOT BETWEEN 1 AND 4096/);
    assert.match(
      inboxSql,
      /pg_catalog\.replace\([\s\S]*?pg_catalog\.encode\(raw_body, 'base64'\)[\s\S]*?E'\\n'[\s\S]*?\) <> p_raw_body_base64/,
    );
    assert.match(
      inboxSql,
      /ADD CONSTRAINT event_receipts_facility_one_check[\s\S]*?CHECK \(facility_id = 1\) NOT VALID/,
    );
    assert.match(inboxSql, /envelope ->> 'facilityId' <> '1'/);
    assert.match(inboxSql, /IF NOT COALESCE\(\(/);
    assert.equal(
      [...inboxSql.matchAll(/AND data_object \? 'change'/g)].length,
      5,
    );
    assert.match(inboxSql, /data_object \? 'isVerified'/);
    assert.match(inboxSql, /data_object \? 'thresholdDays'/);
    assert.match(
      inboxSql,
      /stable_event_digest := pg_catalog\.encode\([\s\S]*?digest\(raw_body, 'sha256'\)/,
    );
    assert.match(
      inboxSql,
      /ON CONFLICT ON CONSTRAINT event_receipts_pkey DO NOTHING/,
    );
    assert.match(inboxSql, /RETURN QUERY SELECT parsed_event_id, 'inserted'/);
    assert.match(inboxSql, /RETURN QUERY SELECT parsed_event_id, 'duplicate'/);
    assert.match(inboxSql, /RETURN QUERY SELECT parsed_event_id, 'conflict'/);
    assert.match(
      inboxSql,
      /VALUES \(1, pg_catalog\.decode\(\$1, 'base64'\)/,
    );
    assert.doesNotMatch(
      inboxSql,
      /VALUES \(1, pg_catalog\.decode\('[A-Za-z0-9+/=]{20,}'/,
    );
  },
);

await check("safe response mapping is exact for every DB status", async () => {
  const cases = [
    [
      { receipt_status: "inserted", event_id: baseEnvelope.id },
      202,
      { accepted: true, duplicate: false, eventId: baseEnvelope.id },
    ],
    [
      { receipt_status: "duplicate", event_id: baseEnvelope.id },
      200,
      { accepted: true, duplicate: true, eventId: baseEnvelope.id },
    ],
    [
      { receipt_status: "conflict", event_id: baseEnvelope.id },
      409,
      { accepted: false, code: "idempotency_conflict" },
    ],
    [
      { receipt_status: "invalid_signature", event_id: null },
      401,
      { accepted: false, code: "invalid_signature" },
    ],
    [
      { receipt_status: "expired_signature", event_id: null },
      401,
      { accepted: false, code: "expired_signature" },
    ],
    [
      { receipt_status: "receiver_not_configured", event_id: null },
      503,
      { accepted: false, code: "receiver_not_configured" },
    ],
  ];
  for (const [input, statusCode, responseBody] of cases) {
    const [mapped] = await runCode(mapCode, input);
    assert.equal(mapped.json.statusCode, statusCode);
    assert.deepEqual(mapped.json.responseBody, responseBody);
  }
});

await check(
  "operator docs use one parameterized DB secret and no n8n Crypto credential",
  () => {
    const docs = automationReadme + "\n" + integrations + "\n" + n8nEnv;
    assert.doesNotMatch(docs, /n8n \*\*Crypto\*\* credential/i);
    assert.doesNotMatch(docs, /Compute expected HMAC/);
    assert.doesNotMatch(docs, /Compute stable event HMAC/);
    assert.match(docs, /verify_and_claim_event_receipt/);
    assert.match(docs, /parameterized/i);
    assert.match(
      n8nEnv,
      /Webhook, Code, IF,\s*(?:#[^\r\n]*\r?\n)?# PostgreSQL/,
    );
    assert.doesNotMatch(n8nEnv, /Webhook, Code, IF,\s*Crypto/);
    assert.match(n8nEnv, /^WEBHOOK_URL=https:\/\//m);
    assert.match(n8nEnv, /^N8N_EDITOR_BASE_URL=https:\/\//m);
    assert.doesNotMatch(n8nEnv, /^N8N_WEBHOOK_URL=/m);
    assert.match(
      n8nEnv,
      /^NODES_EXCLUDE=.*"n8n-nodes-base\.crypto".*$/m,
    );
  },
);

console.log("1.." + checks);
console.log("safe n8n DB-verifier package verification passed");
