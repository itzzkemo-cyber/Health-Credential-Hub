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

  it.each([
    "https://user:password@credentials.example.sa",
    "https://credentials.example.sa/app",
    "https://credentials.example.sa/?campaign=reset",
    "https://credentials.example.sa/#fragment",
    "ftp://credentials.example.sa",
  ])("rejects a value that is not a bare HTTP origin: %s", (value) => {
    process.env.PUBLIC_APP_URL = value;
    expect(() => getPublicAppUrl()).toThrow(/valid absolute URL/);
  });

  it("refuses plaintext production links", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "http://credentials.example.sa";
    expect(() => getPublicAppUrl()).toThrow(/valid absolute URL/);
  });
});
