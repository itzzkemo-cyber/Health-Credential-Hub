import type { ReadinessStatus } from "@workspace/api-client-react";

export type DocumentUploadAvailability =
  | "checking"
  | "enabled"
  | "disabled"
  | "unavailable";

export function getDocumentUploadAvailability({
  readiness,
  isLoading,
  isError,
}: {
  readiness?: ReadinessStatus;
  isLoading: boolean;
  isError: boolean;
}): DocumentUploadAvailability {
  if (isLoading) return "checking";
  if (isError || !readiness) return "unavailable";

  return readiness.documentUploads === "enabled" ? "enabled" : "disabled";
}
