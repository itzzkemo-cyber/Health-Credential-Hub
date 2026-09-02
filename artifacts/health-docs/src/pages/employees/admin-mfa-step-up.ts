import type {
  AdminStepUpInput,
  TotpAdminDisableInput,
} from "@workspace/api-client-react";

export const ADMIN_MFA_CURRENT_PASSWORD_FIELD = "currentPassword";
export const ADMIN_MFA_CODE_FIELD = "code";

export type AdminMfaStepUpCredentials = AdminStepUpInput;

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
  return readAdminStepUpCredentials(formData, true);
}

/**
 * Password step-up applies to every administrator. Only the immutable account
 * marked by the API as MFA-protected must also provide a TOTP or backup code.
 */
export function readAdminStepUpCredentials(
  formData: FormData,
  mfaRequired: boolean | undefined,
): AdminMfaStepUpCredentials | null {
  const currentPassword = readCurrentPassword(formData);
  const code = readVerificationCode(formData);
  if (!currentPassword || (mfaRequired !== false && !code)) return null;
  return code ? { currentPassword, code } : { currentPassword };
}

/**
 * Reads step-up credentials only at submit time. The caller must reset the
 * form and mutation state as soon as the request settles so these sensitive
 * values do not linger in component or query state.
 */
export function readAdminMfaStepUpInput(
  formData: FormData,
  userId: number,
  mfaRequired = true,
): TotpAdminDisableInput | null {
  const credentials = readAdminStepUpCredentials(formData, mfaRequired);
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

export function getAccountStateStepUpErrorKey(
  code: string | undefined,
  status: number | undefined,
): string {
  const fallbackKey =
    status === 403
      ? "employees_page.account_state_forbidden"
      : status === 404
        ? "employees_page.account_state_not_found"
        : status === 409
          ? "employees_page.account_state_conflict"
          : "employees_page.account_state_failed";

  return getAdminMfaStepUpErrorKey(code, fallbackKey);
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
