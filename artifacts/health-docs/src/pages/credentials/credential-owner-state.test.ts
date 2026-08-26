import { describe, expect, it } from "vitest";

import { getCredentialOwnerState } from "./credential-owner-state";

describe("credential owner loading gate", () => {
  it("allows an employee to save a document for their own loaded session", () => {
    expect(
      getCredentialOwnerState({
        employeeId: 12,
        currentUserId: 12,
        isLoading: false,
        isError: false,
        hasTargetEmployee: false,
      }),
    ).toBe("ready");
  });

  it("blocks a manager while the selected employee is still loading", () => {
    expect(
      getCredentialOwnerState({
        employeeId: 42,
        currentUserId: 7,
        isLoading: true,
        isError: false,
        hasTargetEmployee: false,
      }),
    ).toBe("loading");
  });

  it("blocks a manager when the employee request fails or has no result", () => {
    const base = {
      employeeId: 42,
      currentUserId: 7,
      isLoading: false,
      hasTargetEmployee: false,
    };

    expect(getCredentialOwnerState({ ...base, isError: true })).toBe("error");
    expect(getCredentialOwnerState({ ...base, isError: false })).toBe("error");
  });

  it("allows a manager only after the selected employee has loaded", () => {
    expect(
      getCredentialOwnerState({
        employeeId: 42,
        currentUserId: 7,
        isLoading: false,
        isError: false,
        hasTargetEmployee: true,
      }),
    ).toBe("ready");
  });
});
