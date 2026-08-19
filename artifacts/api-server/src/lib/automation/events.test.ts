import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationOutboxRow, CredentialRow } from "@workspace/db/schema";
import {
  credentialCreatedEvent,
  credentialExpiryDueEvent,
  credentialVerificationChangedEvent,
  expiryThresholdFor,
  retryBackoffMs,
} from "./events";
import {
  buildAutomationEnvelope,
  deliverAutomationWebhook,
  signAutomationWebhook,
} from "./webhook";

const dnsMocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsMocks.lookup }));

const credential = {
  id: 42,
  employeeId: 7,
  type: "BLS",
  expiryDate: "2026-12-31",
  rowVersion: 3,
  isVerified: true,
} as CredentialRow;

function outbox(
  overrides: Partial<AutomationOutboxRow> = {},
): AutomationOutboxRow {
  return {
    id: "7c0cd5f3-d646-4b87-b20e-70d5d2f42591",
    facilityId: 9,
    credentialId: 42,
    eventType: "credential.created",
    deduplicationKey: "credential.created:42",
    payload: {
      credentialId: 42,
      employeeId: 7,
      credentialType: "BLS",
    },
    attempts: 1,
    availableAt: new Date("2026-08-19T10:00:00.000Z"),
    lockedAt: new Date("2026-08-19T10:00:00.000Z"),
    processedAt: null,
    discardedAt: null,
    lastErrorCode: null,
    createdAt: new Date("2026-08-19T09:59:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  dnsMocks.lookup.mockReset();
});

describe("automation event minimization and idempotency", () => {
  it("builds deterministic, credential-only outbox values", () => {
    expect(credentialCreatedEvent(credential, 9)).toEqual({
      facilityId: 9,
      credentialId: 42,
      eventType: "credential.created",
      deduplicationKey: "credential.created:42",
      payload: {
        credentialId: 42,
        employeeId: 7,
        credentialType: "BLS",
      },
    });
    expect(credentialVerificationChangedEvent(credential, 9)).toMatchObject({
      deduplicationKey: "credential.verification_changed:42:v3",
      payload: { isVerified: true },
    });
    expect(credentialExpiryDueEvent(credential, 9, 12, 15)).toMatchObject({
      deduplicationKey: "credential.expiry_due:42:2026-12-31:15",
      payload: { expiryDate: "2026-12-31", dueInDays: 12, thresholdDays: 15 },
    });
    expect(
      credentialExpiryDueEvent(
        { ...credential, expiryDate: "2027-12-31", rowVersion: 4 },
        9,
        12,
        15,
      ).deduplicationKey,
    ).toBe("credential.expiry_due:42:2027-12-31:15");
  });

  it("rejects unexpected sensitive payload fields instead of forwarding them", () => {
    const row = outbox({
      payload: {
        credentialId: 42,
        employeeId: 7,
        credentialType: "BLS",
        fileUrl: "/objects/private.pdf",
      } as never,
    });
    expect(buildAutomationEnvelope(row)).toBeNull();
  });

  it("signs timestamp and exact body while supplying the event id for dedupe", () => {
    const envelope = buildAutomationEnvelope(outbox());
    expect(envelope).not.toBeNull();
    const key = Buffer.alloc(32, 3);
    const request = signAutomationWebhook(envelope!, key, 1_787_130_000);
    const expected = createHmac("sha256", key)
      .update(`1787130000.${request.body}`)
      .digest("hex");

    expect(request.headers).toMatchObject({
      "Idempotency-Key": envelope!.id,
      "X-Health-Credential-Timestamp": "1787130000",
      "X-Health-Credential-Signature": `sha256=${expected}`,
    });
    expect(request.body).not.toContain("fileUrl");
    expect(request.body).not.toContain("token");
  });

  it("does not treat non-2xx webhook responses as delivered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const envelope = buildAutomationEnvelope(outbox())!;
    const result = await deliverAutomationWebhook(envelope, {
      enabled: true,
      facilityAllowlist: [9],
      requirePublicAddress: false,
      webhookUrl: new URL("https://n8n.example.sa/webhook"),
      secret: Buffer.alloc(32, 4),
      timeoutMs: 1000,
      maxAttempts: 3,
      batchSize: 10,
      pollIntervalMs: 5000,
      lockTimeoutMs: 60000,
      retentionDays: 30,
      pendingMaxAgeDays: 7,
    });
    expect(result).toEqual({
      ok: false,
      errorCode: "http_503",
      permanent: false,
      retryAfterMs: undefined,
    });
  });

  it("honors bounded Retry-After and permanently rejects ordinary 4xx", async () => {
    const envelope = buildAutomationEnvelope(outbox())!;
    const config = {
      enabled: true,
      facilityAllowlist: [9],
      requirePublicAddress: false,
      webhookUrl: new URL("https://n8n.example.sa/webhook"),
      secret: Buffer.alloc(32, 4),
      timeoutMs: 1000,
      maxAttempts: 3,
      batchSize: 10,
      pollIntervalMs: 5000,
      lockTimeoutMs: 60000,
      retentionDays: 30,
      pendingMaxAgeDays: 7,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": "999999" },
          }),
      ),
    );
    await expect(deliverAutomationWebhook(envelope, config)).resolves.toEqual({
      ok: false,
      errorCode: "http_429",
      permanent: false,
      retryAfterMs: 3_600_000,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 400 })),
    );
    await expect(deliverAutomationWebhook(envelope, config)).resolves.toEqual({
      ok: false,
      errorCode: "http_400",
      permanent: true,
    });
  });

  it("blocks a private DNS result in the actual production HTTPS lookup", async () => {
    dnsMocks.lookup.mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);
    const envelope = buildAutomationEnvelope(outbox())!;
    const result = await deliverAutomationWebhook(envelope, {
      enabled: true,
      facilityAllowlist: [9],
      requirePublicAddress: true,
      webhookUrl: new URL("https://n8n.example.sa/webhook"),
      secret: Buffer.alloc(32, 4),
      timeoutMs: 1000,
      maxAttempts: 3,
      batchSize: 10,
      pollIntervalMs: 5000,
      lockTimeoutMs: 60000,
      retentionDays: 30,
      pendingMaxAgeDays: 7,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "blocked_private_address",
      permanent: true,
    });
  });

  it("catches up at the closest expiry threshold and caps retry backoff", () => {
    expect(expiryThresholdFor(91)).toBeNull();
    expect(expiryThresholdFor(59)).toBe(60);
    expect(expiryThresholdFor(12)).toBe(15);
    expect(expiryThresholdFor(0)).toBe(0);
    expect(expiryThresholdFor(-5)).toBe(0);
    expect(retryBackoffMs(1)).toBe(30_000);
    expect(retryBackoffMs(2)).toBe(60_000);
    expect(retryBackoffMs(20)).toBe(3_600_000);
  });
});
