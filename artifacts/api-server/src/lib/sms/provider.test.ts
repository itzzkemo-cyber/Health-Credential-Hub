import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SmsOtpNotConfiguredError,
  SmsOtpProviderError,
  checkPhoneOtp,
  getSmsOtpReadiness,
  isSmsOtpConfigured,
  startPhoneOtp,
} from "./provider";

const ORIGINAL_ENV = { ...process.env };

function configure(): void {
  process.env.SMS_OTP_PROVIDER = "twilio_verify";
  process.env.TWILIO_VERIFY_SERVICE_SID = `VA${"a".repeat(32)}`;
  process.env.TWILIO_API_KEY_SID = `SK${"b".repeat(32)}`;
  process.env.TWILIO_API_KEY_SECRET = "secret-value-long-enough";
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SMS OTP provider", () => {
  const verificationSid = `VE${"c".repeat(32)}`;

  it("distinguishes disabled, configured, and malformed opt-in", () => {
    const disabled: NodeJS.ProcessEnv = {};
    expect(getSmsOtpReadiness(disabled)).toBe("disabled");
    expect(getSmsOtpReadiness({ SMS_OTP_PROVIDER: "twilio_verify" })).toBe(
      "misconfigured",
    );
    expect(
      getSmsOtpReadiness({
        SMS_OTP_PROVIDER: "twilio_verify",
        TWILIO_VERIFY_SERVICE_SID: `VA${"a".repeat(32)}`,
        TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`,
        TWILIO_API_KEY_SECRET: "secret-value-long-enough",
      }),
    ).toBe("configured");
    expect(
      getSmsOtpReadiness({
        TWILIO_VERIFY_SERVICE_SID: `VA${"a".repeat(32)}`,
      }),
    ).toBe("misconfigured");
  });

  it("fails closed when the provider is not configured", async () => {
    delete process.env.SMS_OTP_PROVIDER;
    expect(isSmsOtpConfigured()).toBe(false);
    await expect(startPhoneOtp("+966512345678")).rejects.toBeInstanceOf(
      SmsOtpNotConfiguredError,
    );
  });

  it("starts Twilio Verify without putting credentials or the phone in the URL", async () => {
    configure();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ status: "pending", sid: verificationSid }),
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(startPhoneOtp("+966512345678")).resolves.toBe(verificationSid);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://verify.twilio.com/v2/Services/VA${"a".repeat(32)}/Verifications`,
    );
    expect(url).not.toContain("+966");
    expect(String(init.body)).toBe("To=%2B966512345678&Channel=sms");
    expect(JSON.stringify(init)).not.toContain("secret-value-long-enough");
  });

  it("maps approved, rejected, and provider failures explicitly", async () => {
    configure();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "approved" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkPhoneOtp(verificationSid, "123456")).resolves.toBe(
      "approved",
    );
    await expect(checkPhoneOtp(verificationSid, "000000")).resolves.toBe(
      "rejected",
    );
    await expect(
      checkPhoneOtp(verificationSid, "111111"),
    ).rejects.toBeInstanceOf(SmsOtpProviderError);

    const [, approvedInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(approvedInit.body)).toBe(
      `VerificationSid=${verificationSid}&Code=123456`,
    );
    expect(String(approvedInit.body)).not.toContain("%2B966");
  });
});
