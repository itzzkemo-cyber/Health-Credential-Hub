export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

export function hasAllowedPasswordInputLength(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PASSWORD_MAX_LENGTH
  );
}

export function hasAllowedPasswordLength(value: unknown): value is string {
  return (
    hasAllowedPasswordInputLength(value) &&
    value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH
  );
}
