export type PasswordChangeUser = {
  mustChangePassword?: boolean;
};

export function mustReplaceTemporaryPassword(
  user: PasswordChangeUser | null | undefined,
): boolean {
  return user?.mustChangePassword === true;
}

export function authenticatedLandingPath(
  user: PasswordChangeUser | null | undefined,
): "/" | "/settings" {
  return mustReplaceTemporaryPassword(user) ? "/settings" : "/";
}

export function withPasswordChangeState<T extends object>(
  user: T,
  required: boolean,
): T & { mustChangePassword: boolean } {
  return { ...user, mustChangePassword: required };
}
