import { ApiError } from "@workspace/api-client-react";

export type PrivilegedMfaUser = {
  mfaRequired?: boolean;
  totpEnabled?: boolean;
};

export function isProtectedMfaAccount(
  user: PrivilegedMfaUser | null | undefined,
): boolean {
  // The immutable protected-account decision is made by the API. The client
  // must never infer it from a mutable role, name, email, or facility.
  return user?.mfaRequired === true;
}

export function mustEnrollPrivilegedMfa(
  user: PrivilegedMfaUser | null | undefined,
): boolean {
  if (!isProtectedMfaAccount(user)) return false;

  // Once the API marks this account as protected, a missing/malformed TOTP
  // state is treated as unenrolled. The API remains authoritative as well.
  return user?.totpEnabled !== true;
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
    (error.data as { code?: string } | null)?.code === "MFA_ENROLLMENT_REQUIRED"
  );
}
