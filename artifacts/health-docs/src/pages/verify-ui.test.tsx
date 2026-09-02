import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  hasVerifiedCredentialData,
  VerificationFooter,
} from "./verify";

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

  it("renders a semantic bilingual footer with the developer credit", () => {
    const copy: Record<string, string> = {
      "verify_page.powered_by": "بدعم من وثائقي الصحية",
      "verify_page.developed_by": "تطوير:",
    };
    const html = renderToStaticMarkup(
      <VerificationFooter t={(key) => copy[key] ?? key} />,
    );

    expect(html).toContain("<footer");
    expect(html).toContain("بدعم من وثائقي الصحية");
    expect(html).toContain("ABDULKARIM ALHEJAILI");
    expect(html).toContain('<bdi lang="en" dir="ltr"');
  });
});
