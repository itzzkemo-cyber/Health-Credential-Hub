import { describe, expect, it } from "vitest";
import { safeRequestPath } from "./safeRequestPath";

describe("safe request path logging", () => {
  it("redacts private object identifiers and removes query strings", () => {
    const raw =
      "/api/storage/objects/uploads/employee-document-123?download=1";

    const logged = safeRequestPath(raw);

    expect(logged).toBe("/api/storage/objects/[redacted]");
    expect(logged).not.toContain("employee-document-123");
    expect(logged).not.toContain("download");
  });

  it("redacts public credential verification tokens", () => {
    const raw = "/api/credentials/qr-secret-token/verify/";

    const logged = safeRequestPath(raw);

    expect(logged).toBe("/api/credentials/[redacted]/verify/");
    expect(logged).not.toContain("qr-secret-token");
  });

  it("preserves non-sensitive route paths while dropping their query", () => {
    expect(safeRequestPath("/api/employees?page=2&search=person")).toBe(
      "/api/employees",
    );
    expect(safeRequestPath(undefined)).toBeUndefined();
  });
});
