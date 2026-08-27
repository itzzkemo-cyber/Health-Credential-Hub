import {
  CredentialInputType,
  type OcrReadiness,
  type OcrResult,
} from "@workspace/api-client-react";

export type OcrAvailability =
  "checking" | "enabled" | "disabled" | "unavailable";

export interface CredentialReviewForm {
  type: CredentialInputType;
  holderName: string;
  holderNameAr: string;
  issuerName: string;
  issuerNameAr: string;
  certificateNumber: string;
  issueDate: string;
  expiryDate: string;
  notes: string;
}

export function getOcrAvailability({
  readiness,
  isLoading,
  isError,
}: {
  readiness?: OcrReadiness;
  isLoading: boolean;
  isError: boolean;
}): OcrAvailability {
  if (isLoading) return "checking";
  if (isError || !readiness) return "unavailable";
  return readiness.status === "enabled" ? "enabled" : "disabled";
}

/**
 * Copies only normalized, non-null OCR suggestions after the user explicitly
 * accepts the review. It never submits or verifies a credential.
 */
export function applyReviewedOcrSuggestions(
  current: CredentialReviewForm,
  result: OcrResult,
): CredentialReviewForm {
  const allowedTypes = Object.values(CredentialInputType) as string[];
  const detectedType = allowedTypes.includes(result.detectedType)
    ? (result.detectedType as CredentialInputType)
    : current.type;

  return {
    ...current,
    type: detectedType,
    holderName: result.holderName || current.holderName,
    holderNameAr: result.holderNameAr || current.holderNameAr,
    issuerName: result.issuerName || current.issuerName,
    issuerNameAr: result.issuerNameAr || current.issuerNameAr,
    certificateNumber: result.certificateNumber || current.certificateNumber,
    issueDate: result.issueDate || current.issueDate,
    expiryDate: result.expiryDate || current.expiryDate,
  };
}
