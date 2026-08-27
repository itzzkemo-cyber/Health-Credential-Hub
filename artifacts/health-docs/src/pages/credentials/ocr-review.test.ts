import { describe, expect, it } from "vitest";

import {
  applyReviewedOcrSuggestions,
  getOcrAvailability,
  type CredentialReviewForm,
} from "./ocr-review";

const form: CredentialReviewForm = {
  type: "BLS",
  holderName: "Existing Name",
  holderNameAr: "اسم حالي",
  issuerName: "",
  issuerNameAr: "",
  certificateNumber: "",
  issueDate: "",
  expiryDate: "",
  notes: "User-authored note",
};

describe("OCR human review", () => {
  it("enables the action only after an explicit enabled response", () => {
    expect(
      getOcrAvailability({
        readiness: { status: "enabled" },
        isLoading: false,
        isError: false,
      }),
    ).toBe("enabled");
  });

  it("fails closed while loading, on errors, or for disabled facilities", () => {
    expect(getOcrAvailability({ isLoading: true, isError: false })).toBe(
      "checking",
    );
    expect(
      getOcrAvailability({
        readiness: { status: "disabled" },
        isLoading: false,
        isError: false,
      }),
    ).toBe("disabled");
    expect(getOcrAvailability({ isLoading: false, isError: true })).toBe(
      "unavailable",
    );
  });

  it("copies suggestions only when the user explicitly applies them", () => {
    const result = applyReviewedOcrSuggestions(form, {
      detectedType: "SCFHS_license",
      holderName: null,
      holderNameAr: "اسم مقروء",
      issuerName: "SCFHS",
      issuerNameAr: null,
      certificateNumber: "LIC-42",
      issueDate: "2026-01-02",
      expiryDate: "2027-01-02",
      confidence: {
        overall: 0.91,
        type: 0.9,
        name: 0.7,
        issuer: 0.95,
        certNumber: 0.92,
        issueDate: 0.86,
        expiryDate: 0.88,
      },
    });

    expect(result).toMatchObject({
      type: "SCFHS_license",
      holderName: "Existing Name",
      holderNameAr: "اسم مقروء",
      issuerName: "SCFHS",
      certificateNumber: "LIC-42",
      issueDate: "2026-01-02",
      expiryDate: "2027-01-02",
      notes: "User-authored note",
    });
    expect(form).toMatchObject({
      type: "BLS",
      holderNameAr: "اسم حالي",
      issuerName: "",
    });
  });
});
