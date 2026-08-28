import { describe, expect, it, vi } from "vitest";

import {
  consumeRegistrationToken,
  createRegistrationSubmission,
  focusRegistrationSuccess,
  getRegistrationApiFailure,
  getRegistrationPasswordError,
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
    expect(createRegistrationSubmission("token", overlong, overlong)).toEqual({
      ok: false,
      feedbackKey: "register.weak_password",
    });
  });

  it("fails closed before building a public registration request without an invitation", () => {
    expect(
      createRegistrationSubmission(
        "",
        "StrongPassword123!",
        "StrongPassword123!",
      ),
    ).toEqual({
      ok: false,
      feedbackKey: "register.no_invitation_hint",
    });
  });

  it("builds only token and password without trimming either secret", () => {
    expect(
      createRegistrationSubmission(
        " invitation-token ",
        " password with spaces ",
        " password with spaces ",
      ),
    ).toEqual({
      ok: true,
      data: {
        token: " invitation-token ",
        password: " password with spaces ",
      },
    });
  });

  it("rejects weak and mismatched submissions before calling the API", () => {
    expect(createRegistrationSubmission("token", "short", "short")).toEqual({
      ok: false,
      feedbackKey: "register.weak_password",
    });
    expect(
      createRegistrationSubmission(
        "token",
        "StrongPassword123!",
        "DifferentPassword123!",
      ),
    ).toEqual({
      ok: false,
      feedbackKey: "register.mismatch",
    });
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
    expect(getRegistrationApiFailure("service_unavailable")).toEqual({
      feedbackKey: "register.failed",
      invalidatesInvitation: false,
    });
    expect(getRegistrationApiFailure(undefined)).toEqual({
      feedbackKey: "register.failed",
      invalidatesInvitation: false,
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
