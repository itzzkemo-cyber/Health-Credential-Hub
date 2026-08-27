import { describe, expect, it } from "vitest";

import {
  ADMIN_MFA_CODE_FIELD,
  ADMIN_MFA_CURRENT_PASSWORD_FIELD,
  getAdminMfaDisableErrorKey,
  getAdminMfaStepUpErrorKey,
  readAdminMfaStepUpCredentials,
  readAdminMfaStepUpInput,
  readCurrentPassword,
  readVerificationCode,
} from "./admin-mfa-step-up";

function formData(currentPassword?: string, code?: string): FormData {
  const data = new FormData();
  if (currentPassword !== undefined) {
    data.set(ADMIN_MFA_CURRENT_PASSWORD_FIELD, currentPassword);
  }
  if (code !== undefined) data.set(ADMIN_MFA_CODE_FIELD, code);
  return data;
}

describe("administrator MFA step-up", () => {
  it("builds the generated request body without altering the password", () => {
    expect(
      readAdminMfaStepUpInput(formData(" pass phrase ", " 123456 "), 17),
    ).toEqual({
      userId: 17,
      currentPassword: " pass phrase ",
      code: "123456",
    });
  });

  it("reads reusable credentials without keeping them in component state", () => {
    const data = formData(" pass phrase ", " ABCDE-FGHIJ ");
    expect(readCurrentPassword(data)).toBe(" pass phrase ");
    expect(readVerificationCode(data)).toBe("ABCDE-FGHIJ");
    expect(readAdminMfaStepUpCredentials(data)).toEqual({
      currentPassword: " pass phrase ",
      code: "ABCDE-FGHIJ",
    });
  });

  it.each([
    [formData(undefined, "123456"), 17],
    [formData("password", undefined), 17],
    [formData("password", "   "), 17],
    [formData("password", "123456"), 0],
  ])("rejects an incomplete or invalid step-up submission", (data, userId) => {
    expect(readAdminMfaStepUpInput(data, userId)).toBeNull();
  });

  it("maps fail-closed server results to specific, localized feedback", () => {
    expect(getAdminMfaDisableErrorKey("admin_mfa_required")).toBe(
      "twofa.admin_mfa_required",
    );
    expect(getAdminMfaDisableErrorKey("step_up_failed")).toBe(
      "twofa.admin_step_up_failed",
    );
    expect(getAdminMfaDisableErrorKey(undefined)).toBe(
      "twofa.admin_disable_failed",
    );
    expect(
      getAdminMfaStepUpErrorKey("step_up_failed", "fallback.message"),
    ).toBe("twofa.admin_step_up_failed");
    expect(getAdminMfaStepUpErrorKey(undefined, "fallback.message")).toBe(
      "fallback.message",
    );
  });
});
