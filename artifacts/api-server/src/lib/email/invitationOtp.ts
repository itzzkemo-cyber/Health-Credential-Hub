import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

const OTP_KEY_DOMAIN = "healthdocs/invitation-email-otp/key/v1";
const OTP_CODE_DOMAIN = "healthdocs/invitation-email-otp/code/v1";
const TOKEN_HASH = /^[0-9a-f]{64}$/;
const SALT = /^[0-9a-f]{32}$/;
const CODE_HASH = /^[0-9a-f]{64}$/;
const OTP_CODE = /^[0-9]{6}$/;

function deriveOtpKey(): Buffer {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("Secure session configuration is required for email OTP");
  }
  return createHmac("sha256", sessionSecret)
    .update(OTP_KEY_DOMAIN)
    .digest();
}
export function generateInvitationEmailOtp(): {
  code: string;
  salt: string;
} {
  return {
    code: randomInt(0, 1_000_000).toString().padStart(6, "0"),
    salt: randomBytes(16).toString("hex"),
  };
}

export function hashInvitationEmailOtp(input: {
  tokenHash: string;
  challengeId: number;
  email: string;
  salt: string;
  code: string;
}): string {
  if (
    !TOKEN_HASH.test(input.tokenHash) ||
    !Number.isSafeInteger(input.challengeId) ||
    input.challengeId <= 0 ||
    input.email !== input.email.trim().toLowerCase() ||
    input.email.length === 0 ||
    input.email.length > 320 ||
    !SALT.test(input.salt) ||
    !OTP_CODE.test(input.code)
  ) {
    throw new Error("Invalid email OTP hashing input");
  }
  return createHmac("sha256", deriveOtpKey())
    .update(
      `${OTP_CODE_DOMAIN}\0${input.tokenHash}\0${input.challengeId}\0${input.email}\0${input.salt}\0${input.code}`,
    )
    .digest("hex");
}

export function invitationEmailOtpMatches(
  storedHash: string | null,
  input: Parameters<typeof hashInvitationEmailOtp>[0],
): boolean {
  if (!storedHash || !CODE_HASH.test(storedHash)) return false;
  const expected = hashInvitationEmailOtp(input);
  return timingSafeEqual(
    Buffer.from(storedHash, "hex"),
    Buffer.from(expected, "hex"),
  );
}
