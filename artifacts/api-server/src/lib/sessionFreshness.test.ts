import { describe, expect, it } from "vitest";
import type { User } from "@workspace/db";
import { isFreshActiveSessionActor } from "./sessionFreshness";

function account(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    isActive: true,
    sessionVersion: 3,
    ...overrides,
  } as User;
}

describe("transactional actor session freshness", () => {
  it("accepts only the same active account and session version", () => {
    const requestUser = account();

    expect(isFreshActiveSessionActor(account(), requestUser)).toBe(true);
    expect(
      isFreshActiveSessionActor(account({ sessionVersion: 4 }), requestUser),
    ).toBe(false);
    expect(
      isFreshActiveSessionActor(account({ isActive: false }), requestUser),
    ).toBe(false);
    expect(isFreshActiveSessionActor(account({ id: 8 }), requestUser)).toBe(
      false,
    );
  });
});
