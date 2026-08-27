import { describe, expect, it } from "vitest";
import {
  generateBackupCodes,
  hashBackupCode,
  looksLikeBackupCode,
  normalizeBackupCode,
} from "./totp";

const productionEnv = {
  NODE_ENV: "production",
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("TOTP backup codes", () => {
  it("generates eight unique 128-bit single-use codes", () => {
    const generated = generateBackupCodes(productionEnv);

    expect(generated.plaintext).toHaveLength(8);
    expect(new Set(generated.plaintext).size).toBe(8);
    expect(generated.hashes).toHaveLength(8);
    for (const code of generated.plaintext) {
      expect(normalizeBackupCode(code)).toMatch(/^[0-9a-f]{32}$/);
      expect(looksLikeBackupCode(code)).toBe(true);
    }
    for (const hash of generated.hashes) {
      expect(hash).toMatch(/^hmac:v2:[0-9a-f]{64}$/);
    }
  });

  it("binds stored hashes to the server-side pepper", () => {
    const code = "0123-4567-89AB-CDEF-0123-4567-89AB-CDEF";
    const first = hashBackupCode(code, productionEnv);
    const second = hashBackupCode(code, {
      ...productionEnv,
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
    });

    expect(first).not.toBe(second);
    expect(first).not.toContain(normalizeBackupCode(code));
  });

  it("fails closed without the production pepper", () => {
    expect(() =>
      hashBackupCode("0123-4567-89AB-CDEF-0123-4567-89AB-CDEF", {
        NODE_ENV: "production",
      }),
    ).toThrow(/TOTP_ENCRYPTION_KEY/);
  });

  it("rejects legacy 40-bit backup codes", () => {
    expect(looksLikeBackupCode("ABCDE-12345")).toBe(false);
  });
});
