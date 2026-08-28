import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hasAllowedPasswordInputLength,
  hasAllowedPasswordLength,
} from "./passwordPolicy";

describe("password length policy", () => {
  it("bounds existing-password inputs before password hashing", () => {
    expect(hasAllowedPasswordInputLength("")).toBe(false);
    expect(hasAllowedPasswordInputLength("x")).toBe(true);
    expect(hasAllowedPasswordInputLength("x".repeat(PASSWORD_MAX_LENGTH))).toBe(
      true,
    );
    expect(
      hasAllowedPasswordInputLength("x".repeat(PASSWORD_MAX_LENGTH + 1)),
    ).toBe(false);
    expect(hasAllowedPasswordInputLength(null)).toBe(false);
  });

  it("accepts both inclusive boundaries", () => {
    expect(hasAllowedPasswordLength("x".repeat(PASSWORD_MIN_LENGTH))).toBe(
      true,
    );
    expect(hasAllowedPasswordLength("x".repeat(PASSWORD_MAX_LENGTH))).toBe(
      true,
    );
  });

  it("rejects values outside the bounds and non-strings", () => {
    expect(hasAllowedPasswordLength("x".repeat(PASSWORD_MIN_LENGTH - 1))).toBe(
      false,
    );
    expect(hasAllowedPasswordLength("x".repeat(PASSWORD_MAX_LENGTH + 1))).toBe(
      false,
    );
    expect(hasAllowedPasswordLength(null)).toBe(false);
  });
});
