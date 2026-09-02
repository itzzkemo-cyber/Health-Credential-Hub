import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProtectedMfaStatusActions } from "./TwoFactorCard";

const translate = (key: string) =>
  ({
    "twofa.status_on": "Enabled",
    "twofa.status_off": "Disabled",
    "twofa.regenerate": "Regenerate backup codes",
    "twofa.enable": "Enable MFA",
    "twofa.disable": "Disable MFA",
    "common.loading": "Loading",
  })[key] ?? key;

describe("protected MFA actions", () => {
  it("offers backup-code regeneration but never an MFA disable action", () => {
    const html = renderToStaticMarkup(
      <ProtectedMfaStatusActions
        enabled
        setupPending={false}
        onEnable={vi.fn()}
        onRegenerate={vi.fn()}
        t={translate}
      />,
    );

    expect(html).toContain("Regenerate backup codes");
    expect(html).not.toContain("Disable MFA");
    expect(html).toContain("min-h-11");
  });

  it("offers enrollment when the protected account has not enrolled yet", () => {
    const html = renderToStaticMarkup(
      <ProtectedMfaStatusActions
        enabled={false}
        setupPending={false}
        onEnable={vi.fn()}
        onRegenerate={vi.fn()}
        t={translate}
      />,
    );

    expect(html).toContain("Enable MFA");
    expect(html).not.toContain("Regenerate backup codes");
    expect(html).not.toContain("Disable MFA");
  });
});
