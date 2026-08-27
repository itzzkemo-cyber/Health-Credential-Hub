import {
  mustEnrollPrivilegedMfa,
  type PrivilegedMfaUser,
} from "./account-security-state";

export type PasswordChangeUser = {
  mustChangePassword?: boolean;
};

export type AccountSetupUser = PasswordChangeUser & PrivilegedMfaUser;

export function mustReplaceTemporaryPassword(
  user: PasswordChangeUser | null | undefined,
): boolean {
  return user?.mustChangePassword === true;
}

export function authenticatedLandingPath(
  user: AccountSetupUser | null | undefined,
): "/" | "/settings" {
  return mustReplaceTemporaryPassword(user) || mustEnrollPrivilegedMfa(user)
    ? "/settings"
    : "/";
}

export function withPasswordChangeState<T extends object>(
  user: T,
  required: boolean,
): T & { mustChangePassword: boolean } {
  return { ...user, mustChangePassword: required };
}
