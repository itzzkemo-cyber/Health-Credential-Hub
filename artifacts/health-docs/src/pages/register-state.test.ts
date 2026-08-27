import { describe, expect, it, vi } from "vitest";

import {
  consumeRegistrationToken,
  focusRegistrationSuccess,
  getRegistrationPasswordError,
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

  it("moves focus only when registration has completed", () => {
    const target = { focus: vi.fn() };

    focusRegistrationSuccess(false, target);
    expect(target.focus).not.toHaveBeenCalled();

    focusRegistrationSuccess(true, target);
    expect(target.focus).toHaveBeenCalledOnce();
  });
});
