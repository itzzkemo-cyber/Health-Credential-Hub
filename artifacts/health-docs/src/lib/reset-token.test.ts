import { describe, expect, it, vi } from "vitest";

import { consumeResetToken } from "./reset-token";

function consume(href: string) {
  const state = { route: "reset" };
  const replaceState = vi.fn();
  const token = consumeResetToken(
    { href, pathname: "/reset-password" },
    { state, replaceState },
  );

  return { token, replaceState, state };
}

describe("consumeResetToken", () => {
  it("prefers the fragment token and clears both fragment and query", () => {
    const { token, replaceState, state } = consume(
      "https://credentials.example.sa/reset-password?token=legacy&source=email#token=current%20secret",
    );

    expect(token).toBe("current secret");
    expect(replaceState).toHaveBeenCalledWith(
      state,
      "",
      "/reset-password",
    );
  });

  it("supports previously issued query-string links", () => {
    const { token, replaceState } = consume(
      "https://credentials.example.sa/reset-password?token=legacy%20secret",
    );

    expect(token).toBe("legacy secret");
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it("returns an empty token while still cleaning an invalid link", () => {
    const { token, replaceState } = consume(
      "https://credentials.example.sa/reset-password?source=email#section",
    );

    expect(token).toBe("");
    expect(replaceState).toHaveBeenCalledOnce();
  });
});
