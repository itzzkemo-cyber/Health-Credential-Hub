import { describe, expect, it } from "vitest";

import {
  claimVerificationSubmission,
  releaseVerificationSubmission,
} from "./manager-verification";

describe("manager verification confirmation", () => {
  it("requires a selected document and prevents a duplicate submission", () => {
    const lock = { current: false };
    const credential = { id: 104 };

    expect(claimVerificationSubmission(null, lock)).toBeNull();
    expect(claimVerificationSubmission(credential, lock)).toBe(credential);
    expect(claimVerificationSubmission(credential, lock)).toBeNull();

    releaseVerificationSubmission(lock);
    expect(claimVerificationSubmission(credential, lock)).toBe(credential);
  });
});
