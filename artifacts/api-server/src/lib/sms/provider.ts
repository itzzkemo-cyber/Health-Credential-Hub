const TWILIO_VERIFY_ORIGIN = "https://verify.twilio.com";
const REQUEST_TIMEOUT_MS = 10_000;

export class SmsOtpNotConfiguredError extends Error {
  override name = "SmsOtpNotConfiguredError";
}

export class SmsOtpProviderError extends Error {
  override name = "SmsOtpProviderError";
  constructor(readonly providerStatus?: number) {
    super("SMS verification provider request failed");
  }
}

interface TwilioVerifyConfig {
  serviceSid: string;
  apiKeySid: string;
  apiKeySecret: string;
}

export type SmsOtpReadiness = "disabled" | "configured" | "misconfigured";

interface SmsOtpConfiguration {
  readiness: SmsOtpReadiness;
  twilio?: TwilioVerifyConfig;
}

function readSmsOtpConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): SmsOtpConfiguration {
  const provider = env.SMS_OTP_PROVIDER?.trim() ?? "";
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID?.trim() ?? "";
  const apiKeySid = env.TWILIO_API_KEY_SID?.trim() ?? "";
  const apiKeySecret = env.TWILIO_API_KEY_SECRET ?? "";
  const attemptedConfiguration = Boolean(
    provider || serviceSid || apiKeySid || apiKeySecret,
  );
  if (!attemptedConfiguration) return { readiness: "disabled" };
  if (
    provider !== "twilio_verify" ||
    !/^VA[0-9a-fA-F]{32}$/.test(serviceSid) ||
    !/^SK[0-9a-fA-F]{32}$/.test(apiKeySid) ||
    apiKeySecret.length < 16
  ) {
    return { readiness: "misconfigured" };
  }
  return {
    readiness: "configured",
    twilio: { serviceSid, apiKeySid, apiKeySecret },
  };
}

export function getSmsOtpReadiness(
  env: NodeJS.ProcessEnv = process.env,
): SmsOtpReadiness {
  return readSmsOtpConfiguration(env).readiness;
}

function readTwilioVerifyConfig(): TwilioVerifyConfig {
  const config = readSmsOtpConfiguration();
  if (config.readiness !== "configured" || !config.twilio) {
    throw new SmsOtpNotConfiguredError(
      "Twilio Verify credentials are incomplete or invalid",
    );
  }
  return config.twilio;
}

export function isSmsOtpConfigured(): boolean {
  return getSmsOtpReadiness() === "configured";
}

async function twilioRequest(
  path: string,
  body: URLSearchParams,
): Promise<Response> {
  const config = readTwilioVerifyConfig();
  const authorization = Buffer.from(
    `${config.apiKeySid}:${config.apiKeySecret}`,
  ).toString("base64");
  try {
    return await fetch(
      `${TWILIO_VERIFY_ORIGIN}/v2/Services/${encodeURIComponent(config.serviceSid)}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authorization}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    throw new SmsOtpProviderError();
  }
}

export async function startPhoneOtp(phone: string): Promise<string> {
  const response = await twilioRequest(
    "Verifications",
    new URLSearchParams({ To: phone, Channel: "sms" }),
  );
  if (!response.ok) throw new SmsOtpProviderError(response.status);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SmsOtpProviderError(response.status);
  }
  const verification =
    payload && typeof payload === "object"
      ? (payload as { status?: unknown; sid?: unknown })
      : undefined;
  if (
    verification?.status !== "pending" ||
    typeof verification.sid !== "string" ||
    !/^VE[0-9a-fA-F]{32}$/.test(verification.sid)
  ) {
    throw new SmsOtpProviderError(response.status);
  }
  return verification.sid;
}

export async function checkPhoneOtp(
  verificationSid: string,
  code: string,
): Promise<"approved" | "rejected"> {
  if (!/^VE[0-9a-fA-F]{32}$/.test(verificationSid)) {
    throw new SmsOtpProviderError();
  }
  const response = await twilioRequest(
    "VerificationCheck",
    new URLSearchParams({ VerificationSid: verificationSid, Code: code }),
  );
  // Twilio Verify intentionally returns 404 for a wrong/expired code. Treat it
  // as a normal rejected proof, not as provider downtime.
  if (response.status === 404) return "rejected";
  if (!response.ok) throw new SmsOtpProviderError(response.status);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SmsOtpProviderError(response.status);
  }
  const status =
    payload && typeof payload === "object"
      ? (payload as { status?: unknown }).status
      : undefined;
  if (status === "approved") return "approved";
  if (status === "pending" || status === "canceled") return "rejected";
  throw new SmsOtpProviderError(response.status);
}
