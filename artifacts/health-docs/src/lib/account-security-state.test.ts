import { ApiError } from "@workspace/api-client-react";
import { describe, expect, it } from "vitest";

import {
  isMfaEnrollmentRequiredApiError,
  mustEnrollPrivilegedMfa,
  withMfaEnrollmentState,
} from "./account-security-state";

describe("privileged MFA enrollment state", () => {
  it.each([
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ] as const)("requires TOTP for a %s profile without it", (role) => {
    expect(mustEnrollPrivilegedMfa({ role, totpEnabled: false })).toBe(true);
    expect(mustEnrollPrivilegedMfa({ role })).toBe(true);
  });

  it("does not restrict employees or privileged profiles with TOTP", () => {
    expect(
      mustEnrollPrivilegedMfa({ role: "employee", totpEnabled: false }),
    ).toBe(false);
    expect(
      mustEnrollPrivilegedMfa({ role: "system_admin", totpEnabled: true }),
    ).toBe(false);
  });

  it("updates only the local server-backed TOTP flag", () => {
    const user = { id: 9, role: "system_admin" as const, totpEnabled: false };

    expect(withMfaEnrollmentState(user, false)).toEqual({
      id: 9,
      role: "system_admin",
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
