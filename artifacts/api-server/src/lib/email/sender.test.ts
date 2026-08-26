import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmailNotConfiguredError,
  isEmailConfigured,
  isFixtureRecipient,
  sendEmail,
} from "./sender";

const originalEnvironment = {
  EMAIL_ALERTS_DISABLED: process.env.EMAIL_ALERTS_DISABLED,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
};

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
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "HealthDocs <no-reply@example.sa>";

    delete process.env.EMAIL_ALERTS_DISABLED;
    expect(isEmailConfigured()).toBe(false);

    process.env.EMAIL_ALERTS_DISABLED = "1";
    expect(isEmailConfigured()).toBe(false);

    process.env.EMAIL_ALERTS_DISABLED = "0";
    expect(isEmailConfigured()).toBe(true);

    process.env.RESEND_API_KEY = " ";
    expect(isEmailConfigured()).toBe(false);
  });

  it("does not contact the provider while delivery is disabled", async () => {
    process.env.EMAIL_ALERTS_DISABLED = "1";
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "HealthDocs <no-reply@example.sa>";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendEmail({
        to: "employee@example.sa",
        subject: "Test",
        html: "<p>Test</p>",
      }),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose provider response bodies in delivery errors", async () => {
    process.env.EMAIL_ALERTS_DISABLED = "0";
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "HealthDocs <no-reply@example.sa>";
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
    });
    await expect(delivery).rejects.toThrow(
      "Resend delivery failed (HTTP 422)",
    );
    await expect(delivery).rejects.not.toThrow("employee@example.sa");
  });
});
