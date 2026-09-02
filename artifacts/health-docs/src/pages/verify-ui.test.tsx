import { describe, expect, it } from "vitest";

import { hasVerifiedCredentialData } from "./verify";

describe("public credential verification UI", () => {
  it("treats only complete approved data as publicly verified", () => {
    expect(
      hasVerifiedCredentialData({
        verificationState: "verified",
        type: "BLS",
        issuerName: "Saudi Heart Association",
        issueDate: "2026-01-01",
        expiryDate: "2028-01-01",
        status: "active",
        verificationCode: "ABC12345",
      }),
    ).toBe(true);
    expect(hasVerifiedCredentialData({ verificationState: "pending" })).toBe(
      false,
    );
    expect(
      hasVerifiedCredentialData({
        verificationState: "verified",
        type: "BLS",
      }),
    ).toBe(false);
  });
});
