import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  AUTOMATION_EVENT_TYPES,
  CREDENTIAL_TYPES,
  CREDENTIAL_LIFECYCLE_CHANGES,
  EMPLOYEE_INVITATION_CHANGES,
  EMPLOYEE_LIFECYCLE_CHANGES,
  SCHEDULE_LIFECYCLE_CHANGES,
  SCHEDULE_REQUEST_LIFECYCLE_CHANGES,
  type AutomationEventType,
  type AutomationOutboxRow,
  type CredentialLifecycleChange,
  type EmployeeInvitationChange,
  type EmployeeLifecycleChange,
  type ScheduleLifecycleChange,
  type ScheduleRequestLifecycleChange,
} from "@workspace/db/schema";
import type { AutomationConfig } from "./config";

export type AutomationWebhookData =
  | Record<string, never>
  | { isVerified: boolean }
  | { thresholdDays: number }
  | {
      change:
        | CredentialLifecycleChange
        | EmployeeLifecycleChange
        | EmployeeInvitationChange
        | ScheduleLifecycleChange
        | ScheduleRequestLifecycleChange;
    };

export interface AutomationWebhookEnvelope {
  id: string;
  type: AutomationEventType;
  occurredAt: string;
  facilityId: number;
  data: AutomationWebhookData;
}

export interface SignedWebhookRequest {
  body: string;
  headers: Record<string, string>;
}

/**
 * Fixed n8n Header Auth boundary. The header name is intentionally not
 * configurable so a deployment cannot silently drift from the reviewed
 * receiver credential.
 */
export const AUTOMATION_WEBHOOK_AUTH_HEADER = "X-Health-Credential-Webhook-Key";

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isAllowedChange<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function sanitizeData(
  eventType: AutomationEventType,
  value: unknown,
): AutomationWebhookData | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  if (
    eventType === "credential.created" ||
    eventType === "credential.verification_changed" ||
    eventType === "credential.expiry_due"
  ) {
    const baseValid =
      isPositiveInteger(data.credentialId) &&
      isPositiveInteger(data.employeeId) &&
      typeof data.credentialType === "string" &&
      CREDENTIAL_TYPES.includes(data.credentialType as never);
    if (!baseValid) return null;
  }

  if (eventType === "credential.created") {
    if (!exactKeys(data, ["credentialId", "employeeId", "credentialType"])) {
      return null;
    }
    return {};
  }
  if (eventType === "credential.verification_changed") {
    if (
      !exactKeys(data, [
        "credentialId",
        "employeeId",
        "credentialType",
        "isVerified",
      ]) ||
      typeof data.isVerified !== "boolean"
    ) {
      return null;
    }
    return { isVerified: data.isVerified };
  }
  if (eventType === "credential.expiry_due") {
    if (
      !exactKeys(data, [
        "credentialId",
        "employeeId",
        "credentialType",
        "expiryDate",
        "dueInDays",
        "thresholdDays",
      ]) ||
      typeof data.expiryDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(data.expiryDate) ||
      !isSafeInteger(data.dueInDays) ||
      !isSafeInteger(data.thresholdDays)
    ) {
      return null;
    }
    return { thresholdDays: data.thresholdDays };
  }
  if (eventType === "credential.lifecycle_changed") {
    if (
      !exactKeys(data, ["change"]) ||
      !isAllowedChange(data.change, CREDENTIAL_LIFECYCLE_CHANGES)
    ) {
      return null;
    }
    return { change: data.change };
  }
  if (eventType === "employee.lifecycle_changed") {
    if (
      !exactKeys(data, ["change"]) ||
      !isAllowedChange(data.change, EMPLOYEE_LIFECYCLE_CHANGES)
    ) {
      return null;
    }
    return { change: data.change };
  }
  if (eventType === "employee.invitation_changed") {
    if (
      !exactKeys(data, ["change"]) ||
      !isAllowedChange(data.change, EMPLOYEE_INVITATION_CHANGES)
    ) {
      return null;
    }
    return { change: data.change };
  }
  if (eventType === "schedule.lifecycle_changed") {
    if (
      !exactKeys(data, ["change"]) ||
      !isAllowedChange(data.change, SCHEDULE_LIFECYCLE_CHANGES)
    ) {
      return null;
    }
    return { change: data.change };
  }
  if (eventType === "schedule_request.lifecycle_changed") {
    if (
      !exactKeys(data, ["change"]) ||
      !isAllowedChange(data.change, SCHEDULE_REQUEST_LIFECYCLE_CHANGES)
    ) {
      return null;
    }
    return { change: data.change };
  }
  return null;
}

export function buildAutomationEnvelope(
  row: AutomationOutboxRow,
): AutomationWebhookEnvelope | null {
  if (!AUTOMATION_EVENT_TYPES.includes(row.eventType)) return null;
  const data = sanitizeData(row.eventType, row.payload);
  if (!data) return null;
  return {
    id: row.id,
    type: row.eventType,
    occurredAt: row.createdAt.toISOString(),
    facilityId: row.facilityId,
    data,
  };
}

export function signAutomationWebhook(
  envelope: AutomationWebhookEnvelope,
  secret: Buffer,
  headerAuthSecret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): SignedWebhookRequest {
  const body = JSON.stringify(envelope);
  const timestamp = String(timestampSeconds);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": envelope.id,
      "X-Health-Credential-Event-Id": envelope.id,
      "X-Health-Credential-Event-Type": envelope.type,
      "X-Health-Credential-Timestamp": timestamp,
      "X-Health-Credential-Signature": `sha256=${signature}`,
      [AUTOMATION_WEBHOOK_AUTH_HEADER]: headerAuthSecret,
    },
  };
}

export type DeliveryResult =
  | { ok: true }
  | {
      ok: false;
      errorCode: string;
      permanent?: boolean;
      retryAfterMs?: number;
    };

const MAX_ACKNOWLEDGEMENT_BYTES = 1024;

function acknowledgementResult(
  status: number,
  rawBody: string,
  expectedEventId: string,
): DeliveryResult {
  if (status !== 200 && status !== 202) {
    if (status >= 200 && status < 300) {
      return {
        ok: false,
        errorCode: "unexpected_success_status",
        permanent: true,
      };
    }
    return responseFailure(status);
  }

  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      errorCode: "invalid_acknowledgement",
      permanent: false,
    };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      "accepted",
      "duplicate",
      "eventId",
    ])
  ) {
    return {
      ok: false,
      errorCode: "invalid_acknowledgement",
      permanent: false,
    };
  }
  const acknowledgement = value as Record<string, unknown>;
  if (
    acknowledgement.accepted !== true ||
    acknowledgement.eventId !== expectedEventId ||
    acknowledgement.duplicate !== (status === 200)
  ) {
    return {
      ok: false,
      errorCode: "invalid_acknowledgement",
      permanent: false,
    };
  }
  return { ok: true };
}

async function readFetchAcknowledgement(
  response: Response,
): Promise<string | null> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_ACKNOWLEDGEMENT_BYTES
  ) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ACKNOWLEDGEMENT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

function readNodeAcknowledgement(
  response: IncomingMessage,
  callback: (body: string | null) => void,
): void {
  const declaredLength = Number(response.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_ACKNOWLEDGEMENT_BYTES
  ) {
    response.resume();
    callback(null);
    return;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let completed = false;
  const finish = (body: string | null) => {
    if (completed) return;
    completed = true;
    callback(body);
  };
  response.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_ACKNOWLEDGEMENT_BYTES) {
      response.destroy();
      finish(null);
      return;
    }
    chunks.push(buffer);
  });
  response.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
  response.on("error", () => finish(null));
}

function retryAfterMs(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  const value = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(raw) - Date.now();
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.ceil(value), 60 * 60_000);
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c <= 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) return isPublicIpv4(address);
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicIpv4(mapped);
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

function responseFailure(
  status: number,
  retryAfter?: string | null,
): DeliveryResult {
  // n8n versions can use 401 or 403 for a Header Auth mismatch, and either can
  // occur briefly during coordinated credential rotation. Keep the durable
  // event pending for the worker's smaller contract-retry window. A 409 is
  // deliberately excluded: the receiver reserves it for conflicting content
  // under an existing idempotency key, which can never self-heal.
  const retryable = [401, 403, 408, 425, 429].includes(status) || status >= 500;
  return {
    ok: false,
    errorCode: `http_${status}`,
    permanent: !retryable,
    ...(retryable ? { retryAfterMs: retryAfterMs(retryAfter) } : {}),
  };
}

function publicOnlyLookup(): LookupFunction {
  return (hostname, options, callback) => {
    void lookup(hostname, { ...options, all: true, verbatim: true })
      .then((addresses) => {
        if (
          addresses.length === 0 ||
          addresses.some(
            ({ address, family }) => !isPublicAddress(address, family),
          )
        ) {
          const error = new Error(
            "Webhook hostname resolved to a non-public address",
          ) as NodeJS.ErrnoException;
          error.code = "BLOCKED_PRIVATE_ADDRESS";
          callback(error, "", 4);
          return;
        }
        if (options.all) {
          callback(null, addresses);
          return;
        }
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, "", 4));
  };
}

async function deliverWithPinnedPublicLookup(
  request: SignedWebhookRequest,
  config: AutomationConfig,
): Promise<DeliveryResult> {
  if (!config.webhookUrl) {
    return { ok: false, errorCode: "integration_disabled" };
  }
  const webhookUrl = config.webhookUrl;
  return new Promise((resolve) => {
    const signal = AbortSignal.timeout(config.timeoutMs);
    const outgoing = httpsRequest(
      webhookUrl,
      {
        method: "POST",
        headers: {
          ...request.headers,
          "Content-Length": String(Buffer.byteLength(request.body)),
        },
        lookup: publicOnlyLookup(),
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status === 200 || status === 202) {
          readNodeAcknowledgement(response, (body) =>
            resolve(
              body == null
                ? {
                    ok: false,
                    errorCode: "invalid_acknowledgement",
                    permanent: false,
                  }
                : acknowledgementResult(
                    status,
                    body,
                    request.headers["X-Health-Credential-Event-Id"]!,
                  ),
            ),
          );
          return;
        }
        response.resume();
        if (status >= 200 && status < 300) {
          resolve(
            acknowledgementResult(
              status,
              "",
              request.headers["X-Health-Credential-Event-Id"]!,
            ),
          );
          return;
        }
        const rawRetry = response.headers["retry-after"];
        resolve(
          responseFailure(
            status,
            Array.isArray(rawRetry) ? rawRetry[0] : rawRetry,
          ),
        );
      },
    );
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        errorCode:
          error.code === "BLOCKED_PRIVATE_ADDRESS"
            ? "blocked_private_address"
            : error.name === "TimeoutError" || error.name === "AbortError"
              ? "timeout"
              : error.code === "ENOTFOUND" || error.code === "EAI_AGAIN"
                ? "dns_error"
                : "network_error",
        ...(error.code === "BLOCKED_PRIVATE_ADDRESS"
          ? { permanent: true }
          : {}),
      });
    });
    outgoing.end(request.body);
  });
}

export async function deliverAutomationWebhook(
  envelope: AutomationWebhookEnvelope,
  config: AutomationConfig,
): Promise<DeliveryResult> {
  if (
    !config.enabled ||
    !config.webhookUrl ||
    !config.secret ||
    !config.headerAuthSecret
  ) {
    return { ok: false, errorCode: "integration_disabled" };
  }
  const request = signAutomationWebhook(
    envelope,
    config.secret,
    config.headerAuthSecret,
  );
  // Production uses the same validated lookup for the actual TLS connection,
  // eliminating the DNS pre-check/fetch rebinding gap while retaining the
  // configured hostname for TLS SNI and Host verification.
  if (config.requirePublicAddress) {
    return deliverWithPinnedPublicLookup(request, config);
  }
  try {
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    });
    if (response.ok) {
      const body = await readFetchAcknowledgement(response);
      return body == null
        ? {
            ok: false,
            errorCode: "invalid_acknowledgement",
            permanent: false,
          }
        : acknowledgementResult(response.status, body, envelope.id);
    }
    await response.body?.cancel();
    return responseFailure(
      response.status,
      response.headers.get("Retry-After"),
    );
  } catch (error) {
    return {
      ok: false,
      errorCode:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "network_error",
    };
  }
}
