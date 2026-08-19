import { afterEach, describe, expect, it } from "vitest";
import { getPasswordResetUrl } from "./templates";

const originalNodeEnv = process.env.NODE_ENV;
const originalPublicAppUrl = process.env.PUBLIC_APP_URL;

afterEach(() => {
  for (const [name, value] of [
    ["NODE_ENV", originalNodeEnv],
    ["PUBLIC_APP_URL", originalPublicAppUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("password reset links", () => {
  it("keeps the bearer token out of the HTTP query string", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "https://credentials.example.sa";

    const resetUrl = getPasswordResetUrl("secret token");

    expect(resetUrl).toBe(
      "https://credentials.example.sa/reset-password#token=secret%20token",
    );
    const parsed = new URL(resetUrl!);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("#token=secret%20token");
  });
});
