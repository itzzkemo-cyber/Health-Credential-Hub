import { describe, expect, it } from "vitest";
import {
  isAutomationOutboxEnabled,
  readAutomationConfig,
  readAutomationFacilityAllowlist,
} from "./config";

const secret = Buffer.alloc(32, 7).toString("base64");

describe("automation webhook configuration", () => {
  it("keeps transactional event production off until explicitly enabled", () => {
    expect(isAutomationOutboxEnabled({})).toBe(false);
    expect(
      isAutomationOutboxEnabled({ AUTOMATION_OUTBOX_ENABLED: "true" }),
    ).toBe(true);
    expect(() =>
      isAutomationOutboxEnabled({ AUTOMATION_OUTBOX_ENABLED: "maybe" }),
    ).toThrow(/must be true or false/);
  });

  it("is disabled by default without validating unused provider settings", () => {
    expect(
      readAutomationConfig({
        AUTOMATION_WEBHOOK_URL: "not a url",
        AUTOMATION_WEBHOOK_SECRET: "weak",
      }),
    ).toMatchObject({ enabled: false });
  });

  it("fails closed when enabled configuration is incomplete", () => {
    expect(() =>
      readAutomationConfig({
        AUTOMATION_WEBHOOK_ENABLED: "true",
        AUTOMATION_OUTBOX_ENABLED: "false",
      }),
    ).toThrow(/requires AUTOMATION_OUTBOX_ENABLED/);
    expect(() =>
      readAutomationConfig({
        AUTOMATION_WEBHOOK_ENABLED: "true",
        AUTOMATION_OUTBOX_ENABLED: "true",
      }),
    ).toThrow(/AUTOMATION_WEBHOOK_MODE/);
    expect(() =>
      readAutomationConfig({
        AUTOMATION_WEBHOOK_ENABLED: "true",
        AUTOMATION_OUTBOX_ENABLED: "true",
        AUTOMATION_WEBHOOK_MODE: "SINGLE_CONTROLLER",
      }),
    ).toThrow(/AUTOMATION_FACILITY_ALLOWLIST/);
  });

  it("requires and strictly validates the tenant allowlist", () => {
    expect(() =>
      readAutomationFacilityAllowlist(
        { AUTOMATION_OUTBOX_ENABLED: "true" },
        true,
      ),
    ).toThrow(/required/);
    expect(() =>
      readAutomationFacilityAllowlist(
        { AUTOMATION_FACILITY_ALLOWLIST: "7,all" },
        true,
      ),
    ).toThrow(/positive integer/);
    expect(
      readAutomationFacilityAllowlist(
        { AUTOMATION_FACILITY_ALLOWLIST: "7, 9,7" },
        true,
      ),
    ).toEqual([7, 9]);
  });

  it("requires HTTPS in production and a strong canonical Base64 secret", () => {
    expect(() =>
      readAutomationConfig({
        NODE_ENV: "production",
        AUTOMATION_WEBHOOK_ENABLED: "true",
        AUTOMATION_OUTBOX_ENABLED: "true",
        AUTOMATION_WEBHOOK_MODE: "SINGLE_CONTROLLER",
        AUTOMATION_FACILITY_ALLOWLIST: "17",
        AUTOMATION_WEBHOOK_HOST_ALLOWLIST: "n8n.internal",
        AUTOMATION_WEBHOOK_URL: "http://n8n.internal/webhook",
        AUTOMATION_WEBHOOK_SECRET: secret,
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      readAutomationConfig({
        NODE_ENV: "production",
        AUTOMATION_WEBHOOK_ENABLED: "true",
        AUTOMATION_OUTBOX_ENABLED: "true",
        AUTOMATION_WEBHOOK_MODE: "SINGLE_CONTROLLER",
        AUTOMATION_FACILITY_ALLOWLIST: "17",
        AUTOMATION_WEBHOOK_HOST_ALLOWLIST: "n8n.example.sa",
        AUTOMATION_WEBHOOK_URL: "https://n8n.example.sa/webhook",
        AUTOMATION_WEBHOOK_SECRET: Buffer.alloc(16).toString("base64"),
      }),
    ).toThrow(/at least 32 random bytes/);
  });

  it("accepts bounded production settings", () => {
    const config = readAutomationConfig({
      NODE_ENV: "production",
      AUTOMATION_WEBHOOK_ENABLED: "true",
      AUTOMATION_OUTBOX_ENABLED: "true",
      AUTOMATION_WEBHOOK_MODE: "SINGLE_CONTROLLER",
      AUTOMATION_FACILITY_ALLOWLIST: "17,23",
      AUTOMATION_WEBHOOK_HOST_ALLOWLIST: "n8n.example.sa",
      AUTOMATION_WEBHOOK_URL: "https://n8n.example.sa/webhook/credentials",
      AUTOMATION_WEBHOOK_SECRET: secret,
      AUTOMATION_WEBHOOK_TIMEOUT_MS: "5000",
      AUTOMATION_OUTBOX_LOCK_TIMEOUT_MS: "60000",
      AUTOMATION_OUTBOX_MAX_ATTEMPTS: "5",
    });

    expect(config).toMatchObject({
      enabled: true,
      timeoutMs: 5000,
      lockTimeoutMs: 60000,
      maxAttempts: 5,
      pendingMaxAgeDays: 7,
      facilityAllowlist: [17, 23],
      requirePublicAddress: true,
    });
    expect(config.webhookUrl?.protocol).toBe("https:");
    expect(config.secret).toEqual(Buffer.alloc(32, 7));
  });
});
