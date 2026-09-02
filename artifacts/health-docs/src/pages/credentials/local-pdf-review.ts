import {
  CredentialInputType,
  type OcrResult,
} from "@workspace/api-client-react";

export const LOCAL_PDF_REVIEW_HEADER = "X-HealthDocs-PDF-Text";
export const LOCAL_PDF_REVIEW_VALUE = "review";

function isNullableString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

function isConfidence(value: unknown): value is OcrResult["confidence"] {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const allowedKeys = [
    "overall",
    "type",
    "name",
    "issuer",
    "certNumber",
    "issueDate",
    "expiryDate",
  ];
  return (
    Object.keys(candidate).every((key) => allowedKeys.includes(key)) &&
    allowedKeys.every(
      (key) =>
        typeof candidate[key] === "number" &&
        Number.isFinite(candidate[key]) &&
        (candidate[key] as number) >= 0 &&
        (candidate[key] as number) <= 1,
    )
  );
}

function isOcrResult(value: unknown): value is OcrResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "detectedType",
    "holderName",
    "holderNameAr",
    "issuerName",
    "issuerNameAr",
    "certificateNumber",
    "issueDate",
    "expiryDate",
    "confidence",
  ]);
  const allowedTypes = new Set<string>(Object.values(CredentialInputType));
  return (
    typeof candidate.detectedType === "string" &&
    allowedTypes.has(candidate.detectedType) &&
    Object.keys(candidate).every((key) => allowedKeys.has(key)) &&
    isNullableString(candidate.holderName) &&
    isNullableString(candidate.holderNameAr) &&
    isNullableString(candidate.issuerName) &&
    isNullableString(candidate.issuerNameAr) &&
    isNullableString(candidate.certificateNumber) &&
    isNullableString(candidate.issueDate) &&
    isNullableString(candidate.expiryDate) &&
    isConfidence(candidate.confidence)
  );
}

/**
 * Local PDF review is part of the authenticated same-origin upload route.
 * Never attach this application-only header to a third-party presigned URL.
 */
export function buildLocalPdfReviewHeaders({
  headers,
  contentType,
  uploadUrl,
  pageOrigin,
  requestReview,
}: {
  headers: Record<string, string>;
  contentType: string;
  uploadUrl: string;
  pageOrigin: string;
  requestReview: boolean;
}): { headers: Record<string, string>; reviewRequested: boolean } {
  const reviewRequested =
    requestReview &&
    contentType === "application/pdf" &&
    new URL(uploadUrl, pageOrigin).origin === new URL(pageOrigin).origin;

  return {
    headers: reviewRequested
      ? { ...headers, [LOCAL_PDF_REVIEW_HEADER]: LOCAL_PDF_REVIEW_VALUE }
      : headers,
    reviewRequested,
  };
}

/**
 * The upload endpoint returns only bounded, normalized suggestions. Raw PDF
 * text is never accepted by this parser or retained in client state.
 */
export async function parseLocalPdfReviewResponse(
  response: Pick<Response, "status" | "json">,
): Promise<OcrResult | null> {
  if (response.status === 204) return null;
  if (response.status !== 200) {
    throw new Error("Unexpected local PDF review response");
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid local PDF review response");
  }

  if (
    Object.keys(payload).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(payload, "localExtraction")
  ) {
    throw new Error("Invalid local PDF review response");
  }

  const extraction = (payload as Record<string, unknown>).localExtraction;
  if (!isOcrResult(extraction)) {
    throw new Error("Invalid local PDF extraction suggestions");
  }
  const bounded = (
    value: string | null | undefined,
    maxLength: number,
  ): string | null => {
    if (value == null) return null;
    if (value.length > maxLength) {
      throw new Error("Invalid local PDF extraction suggestions");
    }
    return value;
  };
  const issueDate = bounded(extraction.issueDate, 10);
  const expiryDate = bounded(extraction.expiryDate, 10);
  if (
    (issueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) ||
    (expiryDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate))
  ) {
    throw new Error("Invalid local PDF extraction suggestions");
  }

  // Return a fresh, exact-shape object so future server fields (especially any
  // source text) cannot be retained in React state accidentally.
  return {
    detectedType: extraction.detectedType,
    holderName: bounded(extraction.holderName, 160),
    holderNameAr: bounded(extraction.holderNameAr, 160),
    issuerName: bounded(extraction.issuerName, 160),
    issuerNameAr: bounded(extraction.issuerNameAr, 160),
    certificateNumber: bounded(extraction.certificateNumber, 80),
    issueDate,
    expiryDate,
    confidence: {
      overall: extraction.confidence.overall,
      type: extraction.confidence.type,
      name: extraction.confidence.name,
      issuer: extraction.confidence.issuer,
      certNumber: extraction.confidence.certNumber,
      issueDate: extraction.confidence.issueDate,
      expiryDate: extraction.confidence.expiryDate,
    },
  };
}
