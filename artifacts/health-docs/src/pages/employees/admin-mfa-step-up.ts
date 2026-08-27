import type { TotpAdminDisableInput } from "@workspace/api-client-react";

export const ADMIN_MFA_CURRENT_PASSWORD_FIELD = "currentPassword";
export const ADMIN_MFA_CODE_FIELD = "code";

export type AdminMfaStepUpCredentials = Pick<
  TotpAdminDisableInput,
  "currentPassword" | "code"
>;

export function readCurrentPassword(formData: FormData): string | null {
  const currentPassword = formData.get(ADMIN_MFA_CURRENT_PASSWORD_FIELD);
  return typeof currentPassword === "string" && currentPassword.length > 0
    ? currentPassword
    : null;
}

export function readVerificationCode(formData: FormData): string | null {
  const rawCode = formData.get(ADMIN_MFA_CODE_FIELD);
  if (typeof rawCode !== "string") return null;

  const code = rawCode.trim();
  return code || null;
}

/**
 * Reads administrator step-up credentials only at submit time so password and
 * verification-code fields can remain uncontrolled.
 */
export function readAdminMfaStepUpCredentials(
  formData: FormData,
): AdminMfaStepUpCredentials | null {
  const currentPassword = readCurrentPassword(formData);
  const code = readVerificationCode(formData);
  return currentPassword && code ? { currentPassword, code } : null;
}

/**
 * Reads step-up credentials only at submit time. The caller must reset the
 * form and mutation state as soon as the request settles so these sensitive
 * values do not linger in component or query state.
 */
export function readAdminMfaStepUpInput(
  formData: FormData,
  userId: number,
): TotpAdminDisableInput | null {
  const credentials = readAdminMfaStepUpCredentials(formData);
  if (!Number.isInteger(userId) || userId <= 0 || !credentials) return null;
  return { userId, ...credentials };
}

export function getAdminMfaStepUpErrorKey(
  code: string | undefined,
  fallbackKey: string,
): string {
  if (code === "admin_mfa_required") return "twofa.admin_mfa_required";
  if (code === "step_up_failed") return "twofa.admin_step_up_failed";
  return fallbackKey;
}

export function getAdminMfaDisableErrorKey(
  code: string | undefined,
):
  | "twofa.admin_mfa_required"
  | "twofa.admin_step_up_failed"
  | "twofa.admin_disable_failed" {
  if (code === "admin_mfa_required") return "twofa.admin_mfa_required";
  if (code === "step_up_failed") return "twofa.admin_step_up_failed";
  return "twofa.admin_disable_failed";
}
