import { afterEach, describe, expect, it } from "vitest";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  validateTotpEncryptionConfig,
} from "./totpSecret";

const originalNodeEnv = process.env.NODE_ENV;
const originalKey = process.env.TOTP_ENCRYPTION_KEY;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
  else process.env.TOTP_ENCRYPTION_KEY = originalKey;
});

describe("TOTP secret encryption", () => {
  it("encrypts at rest and decrypts with the configured key", () => {
    process.env.NODE_ENV = "production";
    process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptTotpSecret("JBSWY3DPEHPK3PXP");
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptTotpSecret(encrypted)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("fails closed without a production key", () => {
    process.env.NODE_ENV = "production";
    delete process.env.TOTP_ENCRYPTION_KEY;
    expect(() => validateTotpEncryptionConfig()).toThrow(/required in production/);
  });

  it("rejects an invalid key length", () => {
    process.env.NODE_ENV = "production";
    process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    expect(() => validateTotpEncryptionConfig()).toThrow(/32-byte key/);
  });
});
