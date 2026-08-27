import { ApiError, type UserRole } from "@workspace/api-client-react";

export type PrivilegedMfaUser = {
  role?: UserRole;
  totpEnabled?: boolean;
};

const PRIVILEGED_ROLES: readonly UserRole[] = [
  "supervisor",
  "department_manager",
  "hospital_admin",
  "system_admin",
];

export function mustEnrollPrivilegedMfa(
  user: PrivilegedMfaUser | null | undefined,
): boolean {
  if (!user?.role || !PRIVILEGED_ROLES.includes(user.role)) return false;

  // Privileged profiles fail closed when an older or malformed response omits
  // the TOTP state. The API remains the authorization source of truth.
  return user.totpEnabled !== true;
}

export function withMfaEnrollmentState<T extends object>(
  user: T,
  required: boolean,
): T & { totpEnabled: boolean } {
  return { ...user, totpEnabled: !required };
}

export function isMfaEnrollmentRequiredApiError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;

  return (
    (error.data as { code?: string } | null)?.code ===
    "MFA_ENROLLMENT_REQUIRED"
  );
}
