interface RegistrationTokenLocation {
  href: string;
  pathname: string;
}

interface RegistrationTokenHistory {
  state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export type RegistrationPasswordError =
  "too_short" | "too_long" | "mismatch" | null;

export const REGISTRATION_PASSWORD_MAX_LENGTH = 1024;

export type RegistrationFeedbackKey =
  | "register.failed"
  | "register.invalid_hint"
  | "register.mismatch"
  | "register.no_invitation_hint"
  | "register.weak_password";

export type RegistrationSubmission =
  | {
      ok: true;
      data: {
        token: string;
        password: string;
      };
    }
  | {
      ok: false;
      feedbackKey: RegistrationFeedbackKey;
    };

export interface RegistrationApiFailure {
  feedbackKey: RegistrationFeedbackKey;
  invalidatesInvitation: boolean;
}

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
  if (password.length > REGISTRATION_PASSWORD_MAX_LENGTH) return "too_long";
  if (password !== confirmation) return "mismatch";
  return null;
}

/**
 * Build the only public registration request supported by the web app. The
 * invitation and password are deliberately preserved byte-for-byte; the API
 * remains authoritative for token validity and password policy.
 */
export function createRegistrationSubmission(
  token: string,
  password: string,
  confirmation: string,
): RegistrationSubmission {
  if (!token) {
    return { ok: false, feedbackKey: "register.no_invitation_hint" };
  }

  const passwordError = getRegistrationPasswordError(password, confirmation);
  if (passwordError === "too_short" || passwordError === "too_long") {
    return { ok: false, feedbackKey: "register.weak_password" };
  }
  if (passwordError === "mismatch") {
    return { ok: false, feedbackKey: "register.mismatch" };
  }

  return { ok: true, data: { token, password } };
}

export function getRegistrationApiFailure(
  code: string | undefined,
): RegistrationApiFailure {
  if (code === "weak_password") {
    return {
      feedbackKey: "register.weak_password",
      invalidatesInvitation: false,
    };
  }
  if (code === "invalid_invitation") {
    return {
      feedbackKey: "register.invalid_hint",
      invalidatesInvitation: true,
    };
  }
  return {
    feedbackKey: "register.failed",
    invalidatesInvitation: false,
  };
}

export function focusRegistrationSuccess(
  registrationComplete: boolean,
  target: RegistrationFocusTarget | null,
): void {
  if (registrationComplete) target?.focus();
}
