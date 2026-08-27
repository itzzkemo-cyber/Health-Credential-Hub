import { describe, expect, it } from "vitest";

import {
  authenticatedLandingPath,
  mustReplaceTemporaryPassword,
  withPasswordChangeState,
} from "./password-change-state";

describe("temporary password state", () => {
  it("sends provisioned accounts only to the required password screen", () => {
    const user = { id: 7, mustChangePassword: true };

    expect(mustReplaceTemporaryPassword(user)).toBe(true);
    expect(authenticatedLandingPath(user)).toBe("/settings");
  });

  it("sends an account with a private password to the application", () => {
    expect(authenticatedLandingPath({ id: 7, mustChangePassword: false })).toBe("/");
    expect(authenticatedLandingPath({ id: 7 })).toBe("/");
  });

  it("keeps a privileged account in settings until TOTP is enabled", () => {
    expect(
      authenticatedLandingPath({
        mustChangePassword: false,
        role: "hospital_admin",
        totpEnabled: false,
      }),
    ).toBe("/settings");
    expect(
      authenticatedLandingPath({
        mustChangePassword: false,
        role: "hospital_admin",
        totpEnabled: true,
      }),
    ).toBe("/");
  });

  it("updates only the local profile flag after a server-confirmed change", () => {
    expect(withPasswordChangeState({ id: 7, role: "employee" }, false)).toEqual({
      id: 7,
      role: "employee",
      mustChangePassword: false,
    });
  });
});
