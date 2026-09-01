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
export const REGISTRATION_PHONE_MAX_LENGTH = 32;
export const REGISTRATION_OTP_MIN_LENGTH = 4;
export const REGISTRATION_OTP_MAX_LENGTH = 10;
export const REGISTRATION_OTP_LENGTH = 6;

export type RegistrationFeedbackKey =
  | "register.failed"
  | "register.invalid_hint"
  | "register.invalid_phone"
  | "register.invalid_phone_otp"
  | "register.mismatch"
  | "register.no_invitation_hint"
  | "register.otp_delivery_failed"
  | "register.otp_already_approved"
  | "register.otp_rate_limited"
  | "register.otp_state_changed"
  | "register.otp_unavailable"
  | "register.otp_verification_in_progress"
  | "register.phone_verification_failed"
  | "register.weak_password";

export type RegistrationPhoneOtpStart =
  | {
      ok: true;
      data: {
        token: string;
        phone: string;
      };
    }
  | {
      ok: false;
      feedbackKey: RegistrationFeedbackKey;
    };

export type RegistrationSubmission =
  | {
      ok: true;
      data: {
        token: string;
        password: string;
        phone: string;
        code: string;
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

export interface RegistrationPhoneOtpStartFailure extends RegistrationApiFailure {
  retryAfterSeconds: number | null;
}

interface RegistrationFocusTarget {
  focus(): void;
}

function toAsciiDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
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
 * Normalize Saudi mobile numbers to the server's E.164 representation.
 * Formatting characters are ignored, while extensions and non-Saudi numbers
 * are rejected so the employee sees an actionable error before requesting SMS.
 */
export function normalizeSaudiRegistrationPhone(value: string): string | null {
  const compact = toAsciiDigits(value)
    .trim()
    .replace(/[\s()-]/g, "");
  const digits = compact.startsWith("+") ? compact.slice(1) : compact;

  if (!/^\d+$/.test(digits)) return null;
  if (/^05\d{8}$/.test(digits)) return `+966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `+966${digits}`;
  if (/^009665\d{8}$/.test(digits)) return `+${digits.slice(2)}`;
  if (/^9665\d{8}$/.test(digits)) return `+${digits}`;
  return null;
}

export function maskRegistrationPhone(phone: string): string {
  const normalized = normalizeSaudiRegistrationPhone(phone);
  if (!normalized) return "";
  return `${normalized.slice(0, 6)} ••• ••${normalized.slice(-2)}`;
}

export function normalizeRegistrationOtp(value: string): string {
  return toAsciiDigits(value)
    .replace(/\D/g, "")
    .slice(0, REGISTRATION_OTP_MAX_LENGTH);
}

export function isRegistrationOtpComplete(value: string): boolean {
  return value.length === REGISTRATION_OTP_LENGTH && /^\d+$/.test(value);
}

export function createRegistrationPhoneOtpStart(
  token: string,
  phone: string,
): RegistrationPhoneOtpStart {
  if (!token) {
    return { ok: false, feedbackKey: "register.no_invitation_hint" };
  }

  const normalizedPhone = normalizeSaudiRegistrationPhone(phone);
  if (!normalizedPhone) {
    return { ok: false, feedbackKey: "register.invalid_phone" };
  }

  return { ok: true, data: { token, phone: normalizedPhone } };
}

export function getRegistrationResendSeconds(
  deadlineMs: number,
  nowMs: number,
): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
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
  phone = "",
  code = "",
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

  const normalizedPhone = normalizeSaudiRegistrationPhone(phone);
  if (!normalizedPhone) {
    return { ok: false, feedbackKey: "register.invalid_phone" };
  }
  if (!isRegistrationOtpComplete(code)) {
    return { ok: false, feedbackKey: "register.invalid_phone_otp" };
  }

  return {
    ok: true,
    data: { token, password, phone: normalizedPhone, code },
  };
}

export function getRegistrationPhoneOtpStartFailure(
  code: string | undefined,
  retryAfterSeconds?: number,
): RegistrationPhoneOtpStartFailure {
  if (code === "invalid_invitation") {
    return {
      feedbackKey: "register.phone_verification_failed",
      invalidatesInvitation: false,
      retryAfterSeconds: null,
    };
  }
  if (code === "otp_rate_limited" || code === "rate_limited") {
    return {
      feedbackKey: "register.otp_rate_limited",
      invalidatesInvitation: false,
      retryAfterSeconds:
        typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
          ? retryAfterSeconds
          : null,
    };
  }
  if (code === "otp_operation_in_progress") {
    return {
      feedbackKey: "register.otp_verification_in_progress",
      invalidatesInvitation: false,
      retryAfterSeconds:
        typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
          ? retryAfterSeconds
          : null,
    };
  }
  if (code === "otp_already_approved") {
    return {
      feedbackKey: "register.otp_already_approved",
      invalidatesInvitation: false,
      retryAfterSeconds: null,
    };
  }
  if (code === "otp_delivery_failed") {
    return {
      feedbackKey: "register.otp_delivery_failed",
      invalidatesInvitation: false,
      retryAfterSeconds: null,
    };
  }
  if (code === "otp_unavailable") {
    return {
      feedbackKey: "register.otp_unavailable",
      invalidatesInvitation: false,
      retryAfterSeconds: null,
    };
  }
  return {
    feedbackKey: "register.failed",
    invalidatesInvitation: false,
    retryAfterSeconds: null,
  };
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
  if (code === "invalid_phone_otp") {
    return {
      feedbackKey: "register.invalid_phone_otp",
      invalidatesInvitation: false,
    };
  }
  if (code === "otp_verification_in_progress") {
    return {
      feedbackKey: "register.otp_verification_in_progress",
      invalidatesInvitation: false,
    };
  }
  if (code === "otp_rate_limited" || code === "rate_limited") {
    return {
      feedbackKey: "register.otp_rate_limited",
      invalidatesInvitation: false,
    };
  }
  if (code === "otp_provider_failed" || code === "otp_unavailable") {
    return {
      feedbackKey: "register.otp_unavailable",
      invalidatesInvitation: false,
    };
  }
  if (code === "otp_state_changed") {
    return {
      feedbackKey: "register.otp_state_changed",
      invalidatesInvitation: false,
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
