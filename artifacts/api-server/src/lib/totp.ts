import * as OTPAuth from "otpauth";
import { createHmac, randomBytes } from "node:crypto";

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
// 8 single-use codes shown exactly once. Codes carry 128 bits of entropy and
// only a versioned, server-peppered HMAC is stored in PostgreSQL.

const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_BYTES = 16;
const BACKUP_HASH_PREFIX = "hmac:v2:";
const BACKUP_HASH_CONTEXT = "wathaiqi-health-backup-code-v2";
const DEVELOPMENT_ONLY_PEPPER = Buffer.from(
  "development-only-backup-code-pepper",
  "utf8",
);

export interface BackupCodeSet {
  /** Plaintext codes formatted XXXX-...-XXXX — returned to the user once. */
  plaintext: string[];
  /** Versioned, peppered HMAC digests — what gets persisted. */
  hashes: string[];
}

export function normalizeBackupCode(code: string): string {
  return code.replace(/[\s-]/g, "").toLowerCase();
}

function backupCodePepper(env: NodeJS.ProcessEnv): Buffer {
  const encoded = env.TOTP_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    if (env.NODE_ENV === "production") {
      throw new Error("TOTP_ENCRYPTION_KEY is required to hash backup codes");
    }
    return DEVELOPMENT_ONLY_PEPPER;
  }
  const encryptionKey = Buffer.from(encoded, "base64");
  if (encryptionKey.length !== 32) {
    throw new Error("TOTP_ENCRYPTION_KEY must be a Base64-encoded 32-byte key");
  }
  return createHmac("sha256", encryptionKey)
    .update(BACKUP_HASH_CONTEXT, "utf8")
    .digest();
}

export function hashBackupCode(
  code: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${BACKUP_HASH_PREFIX}${createHmac("sha256", backupCodePepper(env))
    .update(normalizeBackupCode(code), "utf8")
    .digest("hex")}`;
}

export function generateBackupCodes(
  env: NodeJS.ProcessEnv = process.env,
): BackupCodeSet {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const raw = randomBytes(BACKUP_CODE_BYTES).toString("hex").toUpperCase();
    const formatted = raw.match(/.{1,4}/g)?.join("-") ?? raw;
    plaintext.push(formatted);
    hashes.push(hashBackupCode(formatted, env));
  }
  return { plaintext, hashes };
}

/** Looks like a backup code (rather than a 6-digit OTP)? */
export function looksLikeBackupCode(code: string): boolean {
  return /^[0-9a-f]{32}$/.test(normalizeBackupCode(code));
}
