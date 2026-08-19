import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  AUTOMATION_EVENT_TYPES,
  CREDENTIAL_TYPES,
  type AutomationEventData,
  type AutomationEventType,
  type AutomationOutboxRow,
} from "@workspace/db/schema";
import type { AutomationConfig } from "./config";

export interface AutomationWebhookEnvelope {
  id: string;
  type: AutomationEventType;
  occurredAt: string;
  facilityId: number;
  data: AutomationEventData;
}

export interface SignedWebhookRequest {
  body: string;
  headers: Record<string, string>;
}

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

function sanitizeData(
  eventType: AutomationEventType,
  value: unknown,
): AutomationEventData | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  const baseValid =
    isPositiveInteger(data.credentialId) &&
    isPositiveInteger(data.employeeId) &&
    typeof data.credentialType === "string" &&
    CREDENTIAL_TYPES.includes(data.credentialType as never);
  if (!baseValid) return null;

  if (eventType === "credential.created") {
    if (!exactKeys(data, ["credentialId", "employeeId", "credentialType"])) {
      return null;
    }
    return data as AutomationEventData;
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
    return data as AutomationEventData;
  }
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
    !Number.isSafeInteger(data.dueInDays) ||
    !Number.isSafeInteger(data.thresholdDays)
  ) {
    return null;
  }
  return data as AutomationEventData;
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
  const retryable = [408, 409, 425, 429].includes(status) || status >= 500;
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
        response.resume();
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve({ ok: true });
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
  if (!config.enabled || !config.webhookUrl || !config.secret) {
    return { ok: false, errorCode: "integration_disabled" };
  }
  const request = signAutomationWebhook(envelope, config.secret);
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
    await response.body?.cancel();
    if (response.ok) return { ok: true };
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
