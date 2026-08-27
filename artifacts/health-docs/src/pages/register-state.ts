interface RegistrationTokenLocation {
  href: string;
  pathname: string;
}

interface RegistrationTokenHistory {
  state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export type RegistrationPasswordError = "too_short" | "mismatch" | null;

interface RegistrationFocusTarget {
  focus(): void;
}

/**
 * Move an employee-invitation token from the URL fragment into caller-owned
 * memory, then immediately remove every query and fragment value from the
 * visible address. Query-string tokens are intentionally unsupported.
 */
export function consumeRegistrationToken(
  location: RegistrationTokenLocation,
  history: RegistrationTokenHistory,
): string {
  const url = new URL(location.href);
  const token = new URLSearchParams(url.hash.slice(1)).get("token") ?? "";

  history.replaceState(history.state, "", location.pathname);
  return token;
}

export function getRegistrationPasswordError(
  password: string,
  confirmation: string,
): RegistrationPasswordError {
  if (password.length < 12) return "too_short";
  if (password !== confirmation) return "mismatch";
  return null;
}

export function focusRegistrationSuccess(
  registrationComplete: boolean,
  target: RegistrationFocusTarget | null,
): void {
  if (registrationComplete) target?.focus();
}
