import type { User } from "@workspace/db";

type ProtectedMfaEnvironment = {
  NODE_ENV?: string;
  PROTECTED_MFA_USER_ID?: string;
};

export function readProtectedMfaUserId(
  environment: ProtectedMfaEnvironment,
): number {
  const raw = environment.PROTECTED_MFA_USER_ID?.trim();
  if (!raw && environment.NODE_ENV !== "production") return 1;
  if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(
      "PROTECTED_MFA_USER_ID must be a positive safe integer in production",
    );
  }
  return Number(raw);
}

const protectedUserId = readProtectedMfaUserId(process.env);

/** The one TOTP-protected account, keyed only by immutable database ID. */
export function isProtectedMfaUser(
  user: Pick<User, "id"> | null | undefined,
): boolean {
  return user?.id === protectedUserId;
}

export function getProtectedMfaUserId(): number {
  return protectedUserId;
}
