import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmailNotConfiguredError,
  createEmailIdempotencyKey,
  getEmailDeliveryReadiness,
  isEmailConfigured,
  isFixtureRecipient,
  sendEmail,
} from "./sender";

const originalEnvironment = {
  EMAIL_ALERTS_DISABLED: process.env.EMAIL_ALERTS_DISABLED,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
  NODE_ENV: process.env.NODE_ENV,
};

const idempotencyKey = createEmailIdempotencyKey("test", "message-1");

function configureEmail(): void {
  process.env.EMAIL_ALERTS_DISABLED = "0";
  process.env.RESEND_API_KEY = "re_test_key_1234567890";
  process.env.EMAIL_FROM = "وثائقي الصحية <no-reply@updates.example.sa>";
  process.env.PUBLIC_APP_URL = "https://credentials.example.sa";
  process.env.NODE_ENV = "production";
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
});

describe("email delivery configuration", () => {
  it("suppresses only reserved .invalid fixture recipients", () => {
    expect(isFixtureRecipient("employee@healthdocs.invalid")).toBe(true);
    expect(isFixtureRecipient("employee@qa.hospital.invalid")).toBe(true);
    expect(isFixtureRecipient("employee@hospital.sa")).toBe(false);
    expect(isFixtureRecipient("employee@healthdocs.sa")).toBe(false);
  });

  it("stays disabled unless alerts are explicitly enabled with both provider values", () => {
    process.env.RESEND_API_KEY = "re_test_key_1234567890";
    process.env.EMAIL_FROM = "HealthDocs <no-reply@example.sa>";
    process.env.PUBLIC_APP_URL = "https://credentials.example.sa";
    process.env.NODE_ENV = "production";

    delete process.env.EMAIL_ALERTS_DISABLED;
    expect(isEmailConfigured()).toBe(false);

    process.env.EMAIL_ALERTS_DISABLED = "1";
    expect(isEmailConfigured()).toBe(false);

    process.env.EMAIL_ALERTS_DISABLED = "0";
    expect(isEmailConfigured()).toBe(true);

    process.env.RESEND_API_KEY = " ";
    expect(isEmailConfigured()).toBe(false);
  });

  it("reports attempted malformed opt-in without exposing configuration values", () => {
    configureEmail();
    expect(getEmailDeliveryReadiness()).toBe("configured");

    process.env.EMAIL_ALERTS_DISABLED = "true";
    expect(getEmailDeliveryReadiness()).toBe("misconfigured");

    process.env.EMAIL_ALERTS_DISABLED = "0";
    process.env.EMAIL_FROM =
      "HealthDocs\r\nBcc: attacker@example.test <no-reply@example.sa>";
    expect(getEmailDeliveryReadiness()).toBe("misconfigured");

    process.env.EMAIL_FROM = "HealthDocs <no-reply@example.sa>";
    process.env.PUBLIC_APP_URL = "http://credentials.example.sa";
    expect(getEmailDeliveryReadiness()).toBe("misconfigured");
  });

  it("hashes provider idempotency keys instead of exposing uniqueness material", () => {
    const raw = "sensitive-reset-token-hash";
    const key = createEmailIdempotencyKey("password-reset", raw);
    expect(key).toMatch(/^healthdocs-[a-f0-9]{64}$/);
    expect(key).not.toContain(raw);
  });

  it("does not contact the provider while delivery is disabled", async () => {
    process.env.EMAIL_ALERTS_DISABLED = "1";
    process.env.RESEND_API_KEY = "re_test_key_1234567890";
    process.env.EMAIL_FROM = "HealthDocs <no-reply@example.sa>";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendEmail({
        to: "employee@example.sa",
        subject: "Test",
        html: "<p>Test</p>",
        idempotencyKey,
      }),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose provider response bodies in delivery errors", async () => {
    configureEmail();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("recipient employee@example.sa was rejected", {
          status: 422,
        }),
      ),
    );

    const delivery = sendEmail({
      to: "employee@example.sa",
      subject: "Test",
      html: "<p>Test</p>",
      idempotencyKey,
    });
    await expect(delivery).rejects.toThrow("Resend delivery failed (HTTP 422)");
    await expect(delivery).rejects.not.toThrow("employee@example.sa");
  });

  it("retries a transient response once with the same idempotency key", async () => {
    configureEmail();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("temporary provider detail", {
          status: 503,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail({
      to: "employee@example.sa",
      subject: "Test",
      html: "<p>Test</p>",
      idempotencyKey,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({
        "Idempotency-Key": idempotencyKey,
      });
    }
  });

  it("sends the plain-text fallback beside the HTML body", async () => {
    configureEmail();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail({
      to: "employee@example.sa",
      subject: "Invitation",
      html: '<a href="https://credentials.example.sa/register#token=safe">Activate</a>',
      text: "Activate: https://credentials.example.sa/register#token=safe",
      idempotencyKey,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const payload = JSON.parse(String((init as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      to: ["employee@example.sa"],
      subject: "Invitation",
      text: "Activate: https://credentials.example.sa/register#token=safe",
    });
    expect(payload.html).toContain("#token=safe");
  });
});
