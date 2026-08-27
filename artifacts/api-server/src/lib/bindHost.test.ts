import { describe, expect, it } from "vitest";

import { isLoopbackBindHost, resolveBindHost } from "./bindHost";

describe("resolveBindHost", () => {
  it("defaults non-production runtimes to IPv4 loopback", () => {
    expect(resolveBindHost({ NODE_ENV: "development" })).toBe("127.0.0.1");
  });

  it("requires an explicit production bind host", () => {
    expect(() => resolveBindHost({ NODE_ENV: "production" })).toThrow(
      "BIND_HOST is required in production",
    );
  });

  it.each(["127.0.0.1", "::1", "0.0.0.0", "::", "10.0.0.8"])(
    "accepts an explicit IP address: %s",
    (host) => {
      expect(resolveBindHost({ NODE_ENV: "production", BIND_HOST: host })).toBe(
        host,
      );
    },
  );

  it("rejects hostnames", () => {
    expect(() =>
      resolveBindHost({ NODE_ENV: "production", BIND_HOST: "localhost" }),
    ).toThrow("BIND_HOST must be an IP address");
  });
});
describe("isLoopbackBindHost", () => {
  it("distinguishes tunnel-safe loopback binds from wildcard binds", () => {
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
    expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("::")).toBe(false);
  });
});
