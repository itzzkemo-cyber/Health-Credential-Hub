import { describe, expect, it, vi } from "vitest";

import {
  buildLocalPdfReviewHeaders,
  LOCAL_PDF_REVIEW_HEADER,
  parseLocalPdfReviewResponse,
} from "./local-pdf-review";

const extraction = {
  detectedType: "BLS",
  holderName: "Employee Name",
  holderNameAr: null,
  issuerName: "Saudi Heart Association",
  issuerNameAr: "الجمعية السعودية للقلب",
  certificateNumber: "84880082123",
  issueDate: "2026-02-02",
  expiryDate: "2027-02-02",
  confidence: {
    overall: 0.9,
    type: 0.9,
    name: 0.8,
    issuer: 0.9,
    certNumber: 0.9,
    issueDate: 0.85,
    expiryDate: 0.85,
  },
};

describe("local PDF review upload", () => {
  it("adds the explicit review header only to a same-origin PDF upload", () => {
    const result = buildLocalPdfReviewHeaders({
      headers: { "Content-Type": "application/pdf" },
      contentType: "application/pdf",
      uploadUrl: "/api/storage/uploads/local/abc",
      pageOrigin: "https://app.wathaiqihealth.com",
      requestReview: true,
    });

    expect(result.reviewRequested).toBe(true);
    expect(result.headers[LOCAL_PDF_REVIEW_HEADER]).toBe("review");
  });

  it("does not send the private review header to presigned or image uploads", () => {
    const presigned = buildLocalPdfReviewHeaders({
      headers: {},
      contentType: "application/pdf",
      uploadUrl: "https://storage.example/object",
      pageOrigin: "https://app.wathaiqihealth.com",
      requestReview: true,
    });
    const image = buildLocalPdfReviewHeaders({
      headers: {},
      contentType: "image/jpeg",
      uploadUrl: "/api/storage/uploads/local/abc",
      pageOrigin: "https://app.wathaiqihealth.com",
      requestReview: true,
    });

    expect(presigned.reviewRequested).toBe(false);
    expect(presigned.headers).not.toHaveProperty(LOCAL_PDF_REVIEW_HEADER);
    expect(image.reviewRequested).toBe(false);
    expect(image.headers).not.toHaveProperty(LOCAL_PDF_REVIEW_HEADER);
  });

  it("parses normalized suggestions without applying them to form values", async () => {
    const currentForm = { issuerName: "", certificateNumber: "" };
    const result = await parseLocalPdfReviewResponse({
      status: 200,
      json: vi.fn().mockResolvedValue({ localExtraction: extraction }),
    });

    expect(result).toEqual(extraction);
    expect(currentForm).toEqual({ issuerName: "", certificateNumber: "" });
  });

  it("treats 204 as a readable upload with no extractable text", async () => {
    const json = vi.fn();

    await expect(
      parseLocalPdfReviewResponse({ status: 204, json }),
    ).resolves.toBeNull();
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects malformed suggestion payloads", async () => {
    await expect(
      parseLocalPdfReviewResponse({
        status: 200,
        json: vi.fn().mockResolvedValue({ localExtraction: { rawText: "x" } }),
      }),
    ).rejects.toThrow("Invalid local PDF extraction suggestions");
  });

  it("rejects otherwise valid suggestions carrying an unexpected raw field", async () => {
    await expect(
      parseLocalPdfReviewResponse({
        status: 200,
        json: vi.fn().mockResolvedValue({
          localExtraction: { ...extraction, rawText: "must-not-enter-state" },
        }),
      }),
    ).rejects.toThrow("Invalid local PDF extraction suggestions");
  });

  it("rejects an unexpected top-level raw field", async () => {
    await expect(
      parseLocalPdfReviewResponse({
        status: 200,
        json: vi.fn().mockResolvedValue({
          localExtraction: extraction,
          rawText: "must-not-enter-state",
        }),
      }),
    ).rejects.toThrow("Invalid local PDF review response");
  });
});
