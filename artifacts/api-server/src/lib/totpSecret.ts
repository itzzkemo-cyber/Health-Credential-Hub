import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function encryptionKey(): Buffer | null {
  const value = process.env.TOTP_ENCRYPTION_KEY;
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TOTP_ENCRYPTION_KEY is required in production");
    }
    return null;
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("TOTP_ENCRYPTION_KEY must be a Base64-encoded 32-byte key");
  }
  return key;
}

export function encryptTotpSecret(secret: string): string {
  const key = encryptionKey();
  if (!key) return secret;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

export function decryptTotpSecret(stored: string): string {
  const key = encryptionKey();
  if (!stored.startsWith(PREFIX)) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Refusing to use an unencrypted TOTP secret in production");
    }
    return stored;
  }
  if (!key) throw new Error("TOTP_ENCRYPTION_KEY is required for encrypted secrets");
  const [ivPart, tagPart, ciphertextPart] = stored.slice(PREFIX.length).split(".");
  if (!ivPart || !tagPart || !ciphertextPart) {
    throw new Error("Invalid encrypted TOTP secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// Fail at startup instead of after a user reaches the 2FA screen.
export function validateTotpEncryptionConfig(): void {
  encryptionKey();
}
