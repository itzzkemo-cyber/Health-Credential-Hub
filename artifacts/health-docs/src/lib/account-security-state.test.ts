import { ApiError } from "@workspace/api-client-react";
import { describe, expect, it } from "vitest";

import {
  isMfaEnrollmentRequiredApiError,
  isProtectedMfaAccount,
  mustEnrollPrivilegedMfa,
  withMfaEnrollmentState,
} from "./account-security-state";

describe("privileged MFA enrollment state", () => {
  it("requires TOTP only when the API marks the account as protected", () => {
    expect(
      mustEnrollPrivilegedMfa({ mfaRequired: true, totpEnabled: false }),
    ).toBe(true);
    expect(mustEnrollPrivilegedMfa({ mfaRequired: true })).toBe(true);
    expect(isProtectedMfaAccount({ mfaRequired: true })).toBe(true);
  });

  it("does not infer MFA policy from a role or an unprotected TOTP state", () => {
    expect(
      mustEnrollPrivilegedMfa({ mfaRequired: false, totpEnabled: false }),
    ).toBe(false);
    expect(
      mustEnrollPrivilegedMfa({ mfaRequired: false, totpEnabled: true }),
    ).toBe(false);
    expect(mustEnrollPrivilegedMfa({ totpEnabled: false })).toBe(false);
    expect(isProtectedMfaAccount(undefined)).toBe(false);
    expect(
      mustEnrollPrivilegedMfa({ mfaRequired: true, totpEnabled: true }),
    ).toBe(false);
  });

  it("updates only the local server-backed TOTP flag", () => {
    const user = { id: 9, mfaRequired: true, totpEnabled: false };

    expect(withMfaEnrollmentState(user, false)).toEqual({
      id: 9,
      mfaRequired: true,
      totpEnabled: true,
    });
    expect(user.totpEnabled).toBe(false);
  });

  it("recognizes only the server's privileged enrollment denial", () => {
    const required = new ApiError(
      new Response(null, { status: 403, statusText: "Forbidden" }),
      { code: "MFA_ENROLLMENT_REQUIRED" },
      { method: "GET", url: "/api/employees" },
    );
    const ordinaryForbidden = new ApiError(
      new Response(null, { status: 403, statusText: "Forbidden" }),
      { code: "FORBIDDEN" },
      { method: "GET", url: "/api/employees" },
    );

    expect(isMfaEnrollmentRequiredApiError(required)).toBe(true);
    expect(isMfaEnrollmentRequiredApiError(ordinaryForbidden)).toBe(false);
    expect(isMfaEnrollmentRequiredApiError(new Error("network"))).toBe(false);
  });
});
