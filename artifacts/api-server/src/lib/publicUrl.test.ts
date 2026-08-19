import { afterEach, describe, expect, it } from "vitest";
import { getPublicAppUrl } from "./publicUrl";

const originalNodeEnv = process.env.NODE_ENV;
const originalUrl = process.env.PUBLIC_APP_URL;

afterEach(() => {
  for (const [name, value] of [
    ["NODE_ENV", originalNodeEnv],
    ["PUBLIC_APP_URL", originalUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("public application URL", () => {
  it("normalizes the configured HTTPS URL", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "https://credentials.example.sa/";
    expect(getPublicAppUrl()).toBe("https://credentials.example.sa");
  });

  it("refuses plaintext production links", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "http://credentials.example.sa";
    expect(() => getPublicAppUrl()).toThrow(/valid absolute URL/);
  });
});
