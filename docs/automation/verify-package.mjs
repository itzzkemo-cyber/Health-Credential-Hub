import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "..", "..");
const workflowPath = path.join(
  directory,
  "wathaiqi-n8n-receiver.workflow.json",
);
const [workflowText, inboxSql, credentialSchema, automationSchema] =
  await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(path.join(directory, "n8n-inbox.sql"), "utf8"),
    readFile(
      path.join(repositoryRoot, "lib", "db", "src", "schema", "credentials.ts"),
      "utf8",
    ),
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
  ]);
const workflow = JSON.parse(workflowText);
const node = (name) => {
  const found = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(found, `missing workflow node: ${name}`);
  return found;
};
const quotedValues = (source) =>
  [...source.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);

let checks = 0;
function check(name, callback) {
  callback();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

check(
  "workflow is importable but inactive and does not retain executions",
  () => {
    assert.equal(workflow.active, false);
    assert.equal(workflow.settings.saveDataErrorExecution, "none");
    assert.equal(workflow.settings.saveDataSuccessExecution, "none");
    assert.equal(workflow.settings.saveManualExecutions, false);
    assert.deepEqual(workflow.pinData, {});
  },
);

check(
  "webhook preserves the exact raw body and waits for an explicit response",
  () => {
    const webhook = node("Receive exact raw body");
    assert.equal(webhook.type, "n8n-nodes-base.webhook");
    assert.equal(webhook.parameters.httpMethod, "POST");
    assert.equal(webhook.parameters.responseMode, "responseNode");
    assert.equal(webhook.parameters.options.rawBody, true);
  },
);

check(
  "template contains no embedded credentials or outbound provider nodes",
  () => {
    const allowedNodeTypes = new Set([
      "n8n-nodes-base.webhook",
      "n8n-nodes-base.code",
      "n8n-nodes-base.if",
      "n8n-nodes-base.crypto",
      "n8n-nodes-base.postgres",
      "n8n-nodes-base.respondToWebhook",
      "n8n-nodes-base.stickyNote",
    ]);
    for (const candidate of workflow.nodes) {
      assert.ok(allowedNodeTypes.has(candidate.type), candidate.type);
      assert.equal(candidate.credentials, undefined);
    }
    assert.equal(workflowText.includes("n8n-nodes-base.httpRequest"), false);
    assert.equal(workflowText.includes("https://"), false);
    const crypto = node("Compute expected HMAC");
    assert.equal(crypto.typeVersion, 2);
    assert.equal(crypto.parameters.action, "hmac");
    assert.equal(crypto.parameters.secret, undefined);
    assert.equal(crypto.parameters.value, "={{ $json.signingInput }}");
  },
);

const validateNode = node("Validate raw request");
const validateCode = validateNode.parameters.jsCode;
const compareCode = node("Compare signature in fixed time").parameters.jsCode;

check("facility routing fails closed in the imported template", () => {
  assert.match(
    validateCode,
    /const ALLOWED_FACILITY_IDS = Object\.freeze\(\[\]\);/,
  );
  assert.match(validateCode, /MAX_SKEW_SECONDS = 300/);
  assert.match(validateCode, /MAX_BODY_BYTES = 4096/);
});

check(
  "only the authenticated and tenant-approved branch can reach PostgreSQL",
  () => {
    const targets = (from, branch = 0) =>
      (workflow.connections[from]?.main?.[branch] ?? []).map(
        (edge) => edge.node,
      );
    assert.deepEqual(targets("Request shape valid?", 0), [
      "Compute expected HMAC",
    ]);
    assert.deepEqual(targets("Request shape valid?", 1), [
      "Reject malformed request",
    ]);
    assert.deepEqual(targets("Signature valid?", 0), ["Receiver configured?"]);
    assert.deepEqual(targets("Signature valid?", 1), [
      "Reject invalid signature",
    ]);
    assert.deepEqual(targets("Receiver configured?", 0), [
      "Facility approved?",
    ]);
    assert.deepEqual(targets("Receiver configured?", 1), [
      "Reject unconfigured receiver",
    ]);
    assert.deepEqual(targets("Facility approved?", 0), [
      "Claim event ID atomically",
    ]);
    assert.deepEqual(targets("Facility approved?", 1), [
      "Reject unapproved facility",
    ]);
    const postgresSources = Object.entries(workflow.connections)
      .filter(([, connection]) =>
        connection.main
          .flat()
          .some((edge) => edge.node === "Claim event ID atomically"),
      )
      .map(([name]) => name);
    assert.deepEqual(postgresSources, ["Facility approved?"]);
  },
);

check("event and credential enums match the application contract", () => {
  const workflowCredentialBlock = validateCode.match(
    /const CREDENTIAL_TYPES = Object\.freeze\(\[([\s\S]*?)\]\);/,
  )?.[1];
  const schemaCredentialBlock = credentialSchema.match(
    /export const CREDENTIAL_TYPES = \[([\s\S]*?)\] as const;/,
  )?.[1];
  const workflowEventBlock = validateCode.match(
    /const EVENT_TYPES = Object\.freeze\(\[([\s\S]*?)\]\);/,
  )?.[1];
  const schemaEventBlock = automationSchema.match(
    /export const AUTOMATION_EVENT_TYPES = \[([\s\S]*?)\] as const;/,
  )?.[1];
  assert.ok(workflowCredentialBlock && schemaCredentialBlock);
  assert.ok(workflowEventBlock && schemaEventBlock);
  assert.deepEqual(
    quotedValues(workflowCredentialBlock),
    quotedValues(schemaCredentialBlock),
  );
  assert.deepEqual(
    quotedValues(workflowEventBlock),
    quotedValues(schemaEventBlock),
  );
});

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

const configuredValidateCode = validateCode.replace(
  "const ALLOWED_FACILITY_IDS = Object.freeze([]);",
  "const ALLOWED_FACILITY_IDS = Object.freeze([17]);",
);
assert.notEqual(configuredValidateCode, validateCode);
const receiverSecret = Buffer.alloc(32, 7).toString("base64");
const workerSecret = Buffer.from(receiverSecret, "utf8").toString("base64");
const decodedWorkerSecret = Buffer.from(workerSecret, "base64");
const timestamp = String(Math.floor(Date.now() / 1000));
const event = {
  id: "7c0cd5f3-d646-4b87-b20e-70d5d2f42591",
  type: "credential.created",
  occurredAt: new Date().toISOString(),
  facilityId: 17,
  data: {
    credentialId: 42,
    employeeId: 7,
    credentialType: "BLS",
  },
};
function signedInput(envelope, at = timestamp) {
  const rawBody = Buffer.from(JSON.stringify(envelope), "utf8");
  const signature = createHmac("sha256", decodedWorkerSecret)
    .update(`${at}.${rawBody.toString("utf8")}`)
    .digest("hex");
  return {
    rawBody,
    json: {
      headers: {
        "content-type": "application/json",
        "idempotency-key": envelope.id,
        "x-health-credential-event-id": envelope.id,
        "x-health-credential-event-type": envelope.type,
        "x-health-credential-timestamp": at,
        "x-health-credential-signature": `sha256=${signature}`,
      },
    },
    signature,
  };
}

check(
  "valid HMAC uses the same bytes as the worker Base64 configuration",
  async () => {
    assert.equal(decodedWorkerSecret.toString("utf8"), receiverSecret);
    const request = signedInput(event);
    const [prepared] = await runCode(
      configuredValidateCode,
      request.json,
      request.rawBody,
    );
    assert.equal(prepared.json.precheckOk, true);
    assert.equal(prepared.json.receiverConfigured, true);
    assert.equal(prepared.json.facilityAllowed, true);
    const computedSignature = createHmac("sha256", receiverSecret)
      .update(prepared.json.signingInput)
      .digest("hex");
    assert.equal(computedSignature, request.signature);
    const [comparison] = await runCode(compareCode, {
      ...prepared.json,
      computedSignature,
    });
    assert.equal(comparison.json.signatureValid, true);
    assert.equal("signingInput" in comparison.json, false);
    assert.equal("providedSignature" in comparison.json, false);
  },
);

check(
  "fixed-length signature comparison rejects a changed digest",
  async () => {
    const request = signedInput(event);
    const [prepared] = await runCode(
      configuredValidateCode,
      request.json,
      request.rawBody,
    );
    const wrongSignature = `${request.signature.slice(0, -1)}${
      request.signature.endsWith("0") ? "1" : "0"
    }`;
    const [comparison] = await runCode(compareCode, {
      ...prepared.json,
      computedSignature: wrongSignature,
    });
    assert.equal(comparison.json.signatureValid, false);
    assert.match(compareCode, /for \(let index = 0; index < 64; index \+= 1\)/);
  },
);

check(
  "stale timestamps and unexpected sensitive fields fail closed",
  async () => {
    const staleAt = String(Math.floor(Date.now() / 1000) - 301);
    const stale = signedInput(event, staleAt);
    const [staleResult] = await runCode(
      configuredValidateCode,
      stale.json,
      stale.rawBody,
    );
    assert.equal(staleResult.json.precheckOk, false);
    assert.equal(staleResult.json.statusCode, 401);
    assert.equal(staleResult.json.safeReason, "expired_signature");

    const expanded = structuredClone(event);
    expanded.data.fileUrl = "https://invalid.example/private-object";
    const unsafe = signedInput(expanded);
    const [unsafeResult] = await runCode(
      configuredValidateCode,
      unsafe.json,
      unsafe.rawBody,
    );
    assert.equal(unsafeResult.json.precheckOk, false);
    assert.equal(unsafeResult.json.safeReason, "invalid_payload");
  },
);

check(
  "an authenticated but unlisted facility cannot reach the inbox",
  async () => {
    const otherFacility = { ...event, facilityId: 18 };
    const request = signedInput(otherFacility);
    const [prepared] = await runCode(
      configuredValidateCode,
      request.json,
      request.rawBody,
    );
    assert.equal(prepared.json.precheckOk, true);
    assert.equal(prepared.json.receiverConfigured, true);
    assert.equal(prepared.json.facilityAllowed, false);
  },
);

check("receipt SQL is parameterized, atomic, minimal, and idempotent", () => {
  const postgres = node("Claim event ID atomically");
  const query = postgres.parameters.query;
  assert.match(
    query,
    /VALUES \(\$1::uuid, \$2::integer, \$3::text, \$4::timestamptz\)/,
  );
  assert.match(query, /ON CONFLICT \(event_id\) DO NOTHING/);
  assert.match(query, /RETURNING true AS inserted/);
  assert.equal(query.includes("$json"), false);
  assert.equal(
    postgres.parameters.options.queryReplacement.split(",").length,
    4,
  );

  const tableDefinition = inboxSql.match(
    /CREATE TABLE IF NOT EXISTS wathaiqi_automation\.event_receipts \(([\s\S]*?)\n\);/,
  )?.[1];
  assert.ok(tableDefinition);
  assert.deepEqual(
    [...tableDefinition.matchAll(/^\s{2}([a-z_]+)\s/gm)].map(
      (match) => match[1],
    ),
    ["event_id", "facility_id", "event_type", "occurred_at", "received_at"],
  );
  assert.match(
    inboxSql,
    /GRANT INSERT \(event_id, facility_id, event_type, occurred_at\)/,
  );
  assert.doesNotMatch(
    inboxSql,
    /GRANT (?:UPDATE|DELETE|ALL) ON TABLE[^\n]*TO wathaiqi_n8n_inbox_writer/,
  );

  const receipts = new Set();
  const claim = (eventId) => {
    if (receipts.has(eventId)) return false;
    receipts.add(eventId);
    return true;
  };
  assert.equal(claim(event.id), true);
  assert.equal(claim(event.id), false);
});

console.log(`1..${checks}`);
console.log("safe n8n receiver package verification passed");
