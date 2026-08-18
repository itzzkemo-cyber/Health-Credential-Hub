import * as OTPAuth from "otpauth";
import { createHash, randomBytes } from "node:crypto";

// Authenticator apps show the issuer + label; keep the issuer ASCII so every
// app renders it correctly (the Arabic brand name stays in our own UI).
const ISSUER = "HealthDocs";
const DIGITS = 6;
const PERIOD_SECONDS = 30;

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function buildOtpauthUrl(secretBase32: string, accountEmail: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: accountEmail,
    algorithm: "SHA1", // the only algorithm universally supported by authenticator apps
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

/**
 * Verify a 6-digit OTP against the secret. Returns the absolute time-step the
 * matched code belongs to (for replay protection), or null when invalid.
 * window=1 tolerates one period of clock drift in either direction.
 */
export function verifyOtp(secretBase32: string, code: string): number | null {
  const normalized = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const delta = totp.validate({ token: normalized, window: 1 });
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / PERIOD_SECONDS) + delta;
}

// --- Backup codes ------------------------------------------------------------
// 8 single-use codes shown exactly once; only sha256 hashes are stored.

const BACKUP_CODE_COUNT = 8;

export interface BackupCodeSet {
  /** Plaintext codes formatted XXXXX-XXXXX — returned to the user once. */
  plaintext: string[];
  /** sha256 hex digests of the normalized codes — what gets persisted. */
  hashes: string[];
}

export function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, "").toLowerCase();
}

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}

export function generateBackupCodes(): BackupCodeSet {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
    const formatted = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    plaintext.push(formatted);
    hashes.push(hashBackupCode(formatted));
  }
  return { plaintext, hashes };
}

/** Looks like a backup code (rather than a 6-digit OTP)? */
export function looksLikeBackupCode(code: string): boolean {
  return /^[0-9a-f]{10}$/.test(normalizeBackupCode(code));
}
