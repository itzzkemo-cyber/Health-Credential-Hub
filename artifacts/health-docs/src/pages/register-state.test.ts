import { describe, expect, it, vi } from "vitest";

import {
  consumeRegistrationToken,
  createRegistrationEmailOtpStart,
  createRegistrationSubmission,
  focusRegistrationSuccess,
  getRegistrationApiFailure,
  getRegistrationPasswordError,
  getRegistrationEmailOtpStartFailure,
  getRegistrationResendSeconds,
  isRegistrationOtpComplete,
  normalizeRegistrationOtp,
  REGISTRATION_PASSWORD_MAX_LENGTH,
} from "./register-state";

function consume(href: string) {
  const state = { route: "register" };
  const replaceState = vi.fn();
  const token = consumeRegistrationToken(
    { href, pathname: "/register" },
    { state, replaceState },
  );

  return { token, replaceState, state };
}

describe("employee registration state", () => {
  it("consumes only a fragment token and scrubs the full URL", () => {
    const { token, replaceState, state } = consume(
      "https://app.example.sa/register?source=email#token=single%20use",
    );

    expect(token).toBe("single use");
    expect(replaceState).toHaveBeenCalledWith(state, "", "/register");
  });

  it("does not accept a token from the query string", () => {
    const { token, replaceState } = consume(
      "https://app.example.sa/register?token=must-not-be-read",
    );

    expect(token).toBe("");
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it("validates the minimum length before matching confirmation", () => {
    expect(getRegistrationPasswordError("short", "short")).toBe("too_short");
    expect(
      getRegistrationPasswordError("StrongPassword123!", "different-value"),
    ).toBe("mismatch");
    expect(
      getRegistrationPasswordError("StrongPassword123!", "StrongPassword123!"),
    ).toBeNull();
  });

  it("rejects passwords over the API maximum before matching confirmation", () => {
    const overlong = "A".repeat(REGISTRATION_PASSWORD_MAX_LENGTH + 1);

    expect(getRegistrationPasswordError(overlong, overlong)).toBe("too_long");
    expect(
      createRegistrationSubmission(
        "token",
        overlong,
        overlong,
        "123456",
      ),
    ).toEqual({ ok: false, feedbackKey: "register.weak_password" });
  });

  it("fails closed before building a public registration request without an invitation", () => {
    expect(
      createRegistrationSubmission(
        "",
        "StrongPassword123!",
        "StrongPassword123!",
        "123456",
      ),
    ).toEqual({
      ok: false,
      feedbackKey: "register.no_invitation_hint",
    });
  });

  it("builds the atomic invitation request without trimming secrets", () => {
    expect(
      createRegistrationSubmission(
        " invitation-token ",
        " password with spaces ",
        " password with spaces ",
        "123456",
      ),
    ).toEqual({
      ok: true,
      data: {
        token: " invitation-token ",
        password: " password with spaces ",
        code: "123456",
      },
    });
  });

  it("rejects weak and mismatched submissions before calling the API", () => {
    expect(
      createRegistrationSubmission(
        "token",
        "short",
        "short",
        "123456",
      ),
    ).toEqual({ ok: false, feedbackKey: "register.weak_password" });
    expect(
      createRegistrationSubmission(
        "token",
        "StrongPassword123!",
        "DifferentPassword123!",
        "123456",
      ),
    ).toEqual({
      ok: false,
      feedbackKey: "register.mismatch",
    });
  });

  it("builds an email OTP start request only with an invitation", () => {
    expect(createRegistrationEmailOtpStart("token")).toEqual({
      ok: true,
      data: { token: "token" },
    });
    expect(createRegistrationEmailOtpStart("")).toEqual({
      ok: false,
      feedbackKey: "register.no_invitation_hint",
    });
  });

  it("normalizes and validates email OTP values", () => {
    expect(normalizeRegistrationOtp("12a 34-56 78901")).toBe("1234567890");
    expect(normalizeRegistrationOtp("١٢٣٤٥٦")).toBe("123456");
    expect(isRegistrationOtpComplete("123456")).toBe(true);
    expect(isRegistrationOtpComplete("1234")).toBe(false);
    expect(isRegistrationOtpComplete("1234567890")).toBe(false);
    expect(isRegistrationOtpComplete("123")).toBe(false);
    expect(isRegistrationOtpComplete("12345678901")).toBe(false);
  });

  it("uses the server resend deadline without rounding below zero", () => {
    expect(getRegistrationResendSeconds(60_001, 1)).toBe(60);
    expect(getRegistrationResendSeconds(60_001, 59_100)).toBe(1);
    expect(getRegistrationResendSeconds(60_001, 60_001)).toBe(0);
    expect(getRegistrationResendSeconds(60_001, 90_000)).toBe(0);
  });

  it("requires a complete numeric email OTP for account acceptance", () => {
    expect(
      createRegistrationSubmission(
        "token",
        "StrongPassword123!",
        "StrongPassword123!",
        "12ab",
      ),
    ).toEqual({ ok: false, feedbackKey: "register.invalid_email_otp" });
  });

  it("invalidates only rejected, expired, or replayed invitation links", () => {
    expect(getRegistrationApiFailure("invalid_invitation")).toEqual({
      feedbackKey: "register.invalid_hint",
      invalidatesInvitation: true,
    });
    expect(getRegistrationApiFailure("weak_password")).toEqual({
      feedbackKey: "register.weak_password",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure("invalid_email_otp")).toEqual({
      feedbackKey: "register.invalid_email_otp",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure("otp_verification_in_progress")).toEqual({
      feedbackKey: "register.otp_verification_in_progress",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure("otp_rate_limited")).toEqual({
      feedbackKey: "register.otp_rate_limited",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure("rate_limited")).toEqual({
      feedbackKey: "register.otp_rate_limited",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure("otp_state_changed")).toEqual({
      feedbackKey: "register.otp_state_changed",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure("otp_provider_failed")).toEqual({
      feedbackKey: "register.otp_unavailable",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure("otp_unavailable")).toEqual({
      feedbackKey: "register.otp_unavailable",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure("service_unavailable")).toEqual({
      feedbackKey: "register.failed",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure(undefined)).toEqual({
      feedbackKey: "register.failed",
      invalidatesInvitation: false,
    });
  });

  it("maps OTP delivery failures without discarding a valid invitation", () => {
    expect(getRegistrationEmailOtpStartFailure("otp_rate_limited", 73)).toEqual(
      {
        feedbackKey: "register.otp_rate_limited",
        invalidatesInvitation: false,
        retryAfterSeconds: 73,
      },
    );
    expect(getRegistrationEmailOtpStartFailure("rate_limited", 41)).toEqual({
      feedbackKey: "register.otp_rate_limited",
      invalidatesInvitation: false,
      retryAfterSeconds: 41,
    });
    expect(getRegistrationEmailOtpStartFailure("otp_delivery_failed")).toEqual({
      feedbackKey: "register.otp_delivery_failed",
      invalidatesInvitation: false,
      retryAfterSeconds: null,
    });
    expect(
      getRegistrationEmailOtpStartFailure("otp_operation_in_progress", 17),
    ).toEqual({
      feedbackKey: "register.otp_verification_in_progress",
      invalidatesInvitation: false,
      retryAfterSeconds: 17,
    });
    expect(getRegistrationEmailOtpStartFailure("otp_already_approved")).toEqual(
      {
        feedbackKey: "register.otp_already_approved",
        invalidatesInvitation: false,
        retryAfterSeconds: null,
      },
    );
    expect(getRegistrationEmailOtpStartFailure("otp_unavailable")).toEqual({
      feedbackKey: "register.otp_unavailable",
      invalidatesInvitation: false,
      retryAfterSeconds: null,
    });
    expect(getRegistrationEmailOtpStartFailure("invalid_invitation")).toEqual({
      feedbackKey: "register.email_verification_failed",
      invalidatesInvitation: false,
      retryAfterSeconds: null,
    });
  });

  it("moves focus only when registration has completed", () => {
    const target = { focus: vi.fn() };

    focusRegistrationSuccess(false, target);
    expect(target.focus).not.toHaveBeenCalled();

    focusRegistrationSuccess(true, target);
    expect(target.focus).toHaveBeenCalledOnce();
  });
});
