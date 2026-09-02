import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/settings/TwoFactorCard", () => ({
  default: () => <div data-testid="protected-mfa-settings" />,
}));

import { ProtectedMfaSettings } from "./settings";

describe("protected MFA settings policy", () => {
  it("shows MFA settings only for the account designated by the API", () => {
    const protectedHtml = renderToStaticMarkup(
      <ProtectedMfaSettings user={{ mfaRequired: true, totpEnabled: true }} />,
    );
    const ordinaryAdminHtml = renderToStaticMarkup(
      <ProtectedMfaSettings
        user={{ mfaRequired: false, totpEnabled: false }}
      />,
    );
    const unknownPolicyHtml = renderToStaticMarkup(
      <ProtectedMfaSettings user={{ totpEnabled: true }} />,
    );

    expect(protectedHtml).toContain("protected-mfa-settings");
    expect(ordinaryAdminHtml).toBe("");
    expect(unknownPolicyHtml).toBe("");
  });
});
