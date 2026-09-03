import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationOutboxRow, CredentialRow } from "@workspace/db/schema";
import {
  credentialCreatedEvent,
  credentialExpiryDueEvent,
  credentialLifecycleEvent,
  credentialVerificationChangedEvent,
  employeeInvitationLifecycleEvent,
  employeeLifecycleEvent,
  expiryThresholdFor,
  retryBackoffMs,
  scheduleLifecycleEvent,
  scheduleRequestLifecycleEvent,
} from "./events";
import {
  AUTOMATION_WEBHOOK_AUTH_HEADER,
  buildAutomationEnvelope,
  deliverAutomationWebhook,
  signAutomationWebhook,
} from "./webhook";

const dnsMocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsMocks.lookup }));

const headerAuthSecret = Buffer.alloc(32, 8).toString("base64");

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

  it("builds minimal lifecycle events while keeping resource markers internal", () => {
    expect(credentialLifecycleEvent(9, 42, 5, "updated")).toEqual({
      facilityId: 9,
      credentialId: 42,
      eventType: "credential.lifecycle_changed",
      deduplicationKey: "credential.lifecycle_changed:42:5:updated",
      payload: { change: "updated" },
    });
    expect(employeeLifecycleEvent(9, 77, 4, "updated")).toEqual({
      facilityId: 9,
      credentialId: null,
      eventType: "employee.lifecycle_changed",
      deduplicationKey: "employee.lifecycle_changed:77:4:updated",
      payload: { change: "updated" },
    });
    expect(
      employeeInvitationLifecycleEvent(
        9,
        81,
        "2026-08-20T09:00:00.000Z",
        "revoked",
      ),
    ).toEqual({
      facilityId: 9,
      credentialId: null,
      eventType: "employee.invitation_changed",
      deduplicationKey:
        "employee.invitation_changed:81:2026-08-20T09%3A00%3A00.000Z:revoked",
      payload: { change: "revoked" },
    });
    expect(scheduleLifecycleEvent(9, 23, 6, "published")).toMatchObject({
      credentialId: null,
      deduplicationKey: "schedule.lifecycle_changed:23:6:published",
      payload: { change: "published" },
    });
    expect(
      scheduleRequestLifecycleEvent(9, 31, 8, "approval_revoked"),
    ).toMatchObject({
      credentialId: null,
      deduplicationKey:
        "schedule_request.lifecycle_changed:31:8:approval_revoked",
      payload: { change: "approval_revoked" },
    });

    const serializedPayloads = [
      credentialLifecycleEvent(9, 42, 5, "deleted"),
      employeeLifecycleEvent(9, 77, 4, "updated"),
      employeeInvitationLifecycleEvent(9, 81, 2, "accepted"),
      scheduleLifecycleEvent(9, 23, 6, "published"),
      scheduleRequestLifecycleEvent(9, 31, 8, "approved"),
    ].map((event) => JSON.stringify(event.payload));
    expect(serializedPayloads).toEqual([
      '{"change":"deleted"}',
      '{"change":"updated"}',
      '{"change":"accepted"}',
      '{"change":"published"}',
      '{"change":"approved"}',
    ]);
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

  it.each([
    ["credential.lifecycle_changed", "updated"],
    ["employee.lifecycle_changed", "created"],
    ["employee.invitation_changed", "accepted"],
    ["schedule.lifecycle_changed", "published"],
    ["schedule_request.lifecycle_changed", "approved"],
  ] as const)(
    "rejects additional fields from %s payloads",
    (eventType, change) => {
      const row = outbox({
        credentialId: eventType.startsWith("credential.") ? 99 : null,
        eventType,
        deduplicationKey: `${eventType}:99:1:${change}`,
        payload: { change, resourceId: 99 } as never,
      });
      expect(buildAutomationEnvelope(row)).toBeNull();
    },
  );

  it.each([
    "credential.lifecycle_changed",
    "employee.lifecycle_changed",
    "employee.invitation_changed",
    "schedule.lifecycle_changed",
    "schedule_request.lifecycle_changed",
  ] as const)("rejects unknown change values for %s", (eventType) => {
    const row = outbox({
      credentialId: null,
      eventType,
      payload: { change: "email_and_document_dump" } as never,
    });
    expect(buildAutomationEnvelope(row)).toBeNull();
  });

  it("minimizes credential webhook data independently from internal revalidation data", () => {
    const created = buildAutomationEnvelope(outbox());
    const verification = buildAutomationEnvelope(
      outbox({
        eventType: "credential.verification_changed",
        payload: {
          credentialId: 42,
          employeeId: 7,
          credentialType: "BLS",
          isVerified: true,
        },
      }),
    );
    const expiry = buildAutomationEnvelope(
      outbox({
        eventType: "credential.expiry_due",
        payload: {
          credentialId: 42,
          employeeId: 7,
          credentialType: "BLS",
          expiryDate: "2026-12-31",
          dueInDays: 12,
          thresholdDays: 15,
        },
      }),
    );
    const lifecycle = buildAutomationEnvelope(
      outbox({
        eventType: "credential.lifecycle_changed",
        payload: { change: "deleted" },
      }),
    );

    expect(created?.data).toEqual({});
    expect(verification?.data).toEqual({ isVerified: true });
    expect(expiry?.data).toEqual({ thresholdDays: 15 });
    expect(lifecycle?.data).toEqual({ change: "deleted" });

    const bodies = [created, verification, expiry, lifecycle].map(
      (envelope) =>
        signAutomationWebhook(envelope!, Buffer.alloc(32, 8), headerAuthSecret)
          .body,
    );
    for (const body of bodies) {
      expect(body).not.toContain("credentialId");
      expect(body).not.toContain("employeeId");
      expect(body).not.toContain("credentialType");
      expect(body).not.toContain("expiryDate");
      expect(body).not.toContain("dueInDays");
    }
  });

  it("signs timestamp and exact body while supplying the event id for dedupe", () => {
    const envelope = buildAutomationEnvelope(outbox());
    expect(envelope).not.toBeNull();
    const key = Buffer.alloc(32, 3);
    const request = signAutomationWebhook(
      envelope!,
      key,
      headerAuthSecret,
      1_787_130_000,
    );
    const expected = createHmac("sha256", key)
      .update(`1787130000.${request.body}`)
      .digest("hex");

    expect(request.headers).toMatchObject({
      "Idempotency-Key": envelope!.id,
      "X-Health-Credential-Timestamp": "1787130000",
      "X-Health-Credential-Signature": `sha256=${expected}`,
      [AUTOMATION_WEBHOOK_AUTH_HEADER]: headerAuthSecret,
    });
    expect(JSON.parse(request.body).data).toEqual({});
    expect(request.body).not.toContain("fileUrl");
    expect(request.body).not.toContain("token");
  });

  it("does not treat non-2xx webhook responses as delivered", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const envelope = buildAutomationEnvelope(outbox())!;
    const result = await deliverAutomationWebhook(envelope, {
      enabled: true,
      facilityAllowlist: [9],
      requirePublicAddress: false,
      webhookUrl: new URL("https://n8n.example.sa/webhook"),
      secret: Buffer.alloc(32, 4),
      headerAuthSecret,
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
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(
      new Headers(requestInit.headers).get(AUTOMATION_WEBHOOK_AUTH_HEADER),
    ).toBe(headerAuthSecret);
  });

  it("fails closed without the independent Header Auth secret", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const envelope = buildAutomationEnvelope(outbox())!;

    await expect(
      deliverAutomationWebhook(envelope, {
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
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: "integration_disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors Retry-After, bounds auth retries, and permanently rejects other ordinary 4xx", async () => {
    const envelope = buildAutomationEnvelope(outbox())!;
    const config = {
      enabled: true,
      facilityAllowlist: [9],
      requirePublicAddress: false,
      webhookUrl: new URL("https://n8n.example.sa/webhook"),
      secret: Buffer.alloc(32, 4),
      headerAuthSecret,
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(deliverAutomationWebhook(envelope, config)).resolves.toEqual({
      ok: false,
      errorCode: "http_401",
      permanent: false,
      retryAfterMs: undefined,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(deliverAutomationWebhook(envelope, config)).resolves.toEqual({
      ok: false,
      errorCode: "http_403",
      permanent: false,
      retryAfterMs: undefined,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 409 })),
    );
    await expect(deliverAutomationWebhook(envelope, config)).resolves.toEqual({
      ok: false,
      errorCode: "http_409",
      permanent: true,
    });
  });

  it("retries an invalid acknowledgement instead of losing an accepted event", async () => {
    const envelope = buildAutomationEnvelope(outbox())!;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              accepted: true,
              duplicate: false,
              eventId: "00000000-0000-4000-8000-000000000000",
            }),
            {
              status: 202,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    await expect(
      deliverAutomationWebhook(envelope, {
        enabled: true,
        facilityAllowlist: [9],
        requirePublicAddress: false,
        webhookUrl: new URL("https://n8n.example.sa/webhook"),
        secret: Buffer.alloc(32, 4),
        headerAuthSecret,
        timeoutMs: 1000,
        maxAttempts: 3,
        batchSize: 10,
        pollIntervalMs: 5000,
        lockTimeoutMs: 60000,
        retentionDays: 30,
        pendingMaxAgeDays: 7,
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: "invalid_acknowledgement",
      permanent: false,
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
      headerAuthSecret,
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
