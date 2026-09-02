import { describe, expect, it } from "vitest";

import {
  extractLocalPdfCredentialSuggestions,
  normalizeExtractedPdfDate,
} from "./localPdfExtraction";

describe("local PDF credential text suggestions", () => {
  it.each([
    ["2026-02-02", "2026-02-02"],
    ["2 Feb 2026", "2026-02-02"],
    ["February 2, 2026", "2026-02-02"],
    ["02/02/2026", "2026-02-02"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeExtractedPdfDate(input)).toBe(expected);
  });

  it("extracts review-only fields from a synthetic Saudi Heart certificate", () => {
    const result = extractLocalPdfCredentialSuggestions(
      "Saudi Heart Association BLS Certificate This certifies that TEST EMPLOYEE has successfully completed Basic Life Support eCard Code 84880082123 Date Issued 2 Feb 2026 Expiration Date 2 Feb 2027",
    );

    expect(result).toMatchObject({
      detectedType: "BLS",
      holderName: "TEST EMPLOYEE",
      issuerName: "Saudi Heart Association",
      issuerNameAr: "الجمعية السعودية للقلب",
      certificateNumber: "84880082123",
      issueDate: "2026-02-02",
      expiryDate: "2027-02-02",
    });
  });

  it("returns null rather than inventing values from unrelated text", () => {
    expect(
      extractLocalPdfCredentialSuggestions("plain unrelated document text"),
    ).toBeNull();
  });

  it("does not treat the prose after a bare certificate label as its number", () => {
    expect(
      extractLocalPdfCredentialSuggestions(
        "Saudi Heart Association BLS Certificate This certifies that TEST EMPLOYEE has completed the course",
      )?.certificateNumber,
    ).toBeNull();
  });
});
