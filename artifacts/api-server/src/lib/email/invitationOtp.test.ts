import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateInvitationEmailOtp,
  hashInvitationEmailOtp,
  invitationEmailOtpMatches,
} from "./invitationOtp";

const originalSecret = process.env.SESSION_SECRET;

describe("invitation email OTP", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  });

  it("generates exactly six digits and a fresh 128-bit salt", () => {
    const first = generateInvitationEmailOtp();
    const second = generateInvitationEmailOtp();

    expect(first.code).toMatch(/^[0-9]{6}$/);
    expect(first.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(second.salt).not.toBe(first.salt);
  });

  it("binds the HMAC to token, challenge, normalized invitation email, salt, and code", () => {
    const input = {
      tokenHash: "a".repeat(64),
      challengeId: 42,
      email: "employee@example.sa",
      salt: "b".repeat(32),
      code: "123456",
    };
    const stored = hashInvitationEmailOtp(input);

    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(invitationEmailOtpMatches(stored, input)).toBe(true);
    expect(
      invitationEmailOtpMatches(stored, { ...input, code: "123457" }),
    ).toBe(false);
    expect(
      invitationEmailOtpMatches(stored, {
        ...input,
        email: "other@example.sa",
      }),
    ).toBe(false);
    expect(
      invitationEmailOtpMatches(stored, { ...input, challengeId: 43 }),
    ).toBe(false);
  });

  it("fails closed when the application secret is unavailable", () => {
    delete process.env.SESSION_SECRET;

    expect(() =>
      hashInvitationEmailOtp({
        tokenHash: "a".repeat(64),
        challengeId: 42,
        email: "employee@example.sa",
        salt: "b".repeat(32),
        code: "123456",
      }),
    ).toThrow("Secure session configuration is required");
  });
});
