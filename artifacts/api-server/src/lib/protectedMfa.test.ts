import { describe, expect, it } from "vitest";
import {
  getProtectedMfaUserId,
  isProtectedMfaUser,
  readProtectedMfaUserId,
} from "./protectedMfa";

describe("protected MFA identity", () => {
  it("uses an immutable numeric user id rather than mutable profile fields", () => {
    const id = getProtectedMfaUserId();
    expect(isProtectedMfaUser({ id })).toBe(true);
    expect(isProtectedMfaUser({ id: id + 1 })).toBe(false);
    expect(isProtectedMfaUser(null)).toBe(false);
  });

  it("uses account 1 only as a non-production fallback", () => {
    expect(readProtectedMfaUserId({ NODE_ENV: "test" })).toBe(1);
  });

  it("accepts an explicitly configured immutable account id", () => {
    expect(
      readProtectedMfaUserId({
        NODE_ENV: "production",
        PROTECTED_MFA_USER_ID: " 42 ",
      }),
    ).toBe(42);
  });

  it.each([undefined, "", "0", "-1", "1.5", "abc", "9007199254740992"])(
    "fails closed for an absent or invalid production id: %s",
    (value) => {
      expect(() =>
        readProtectedMfaUserId({
          NODE_ENV: "production",
          PROTECTED_MFA_USER_ID: value,
        }),
      ).toThrow(/PROTECTED_MFA_USER_ID/);
    },
  );
});
