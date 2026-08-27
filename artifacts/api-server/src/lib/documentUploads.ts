export const DOCUMENT_UPLOADS_DISABLED_CODE =
  "DOCUMENT_UPLOADS_DISABLED" as const;

export type DocumentUploadReadiness = "enabled" | "disabled";

/**
 * Document intake is opt-in in production. Development and tests retain the
 * existing workflow unless explicitly disabled. Unknown values fail closed.
 */
export function areDocumentUploadsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env.DOCUMENT_UPLOADS_ENABLED?.trim().toLowerCase();
  if (!configured) return env.NODE_ENV !== "production";
  if (configured === "true") return true;
  if (configured === "false") return false;
  return false;
}

export function getDocumentUploadReadiness(
  env: NodeJS.ProcessEnv = process.env,
): DocumentUploadReadiness {
  return areDocumentUploadsEnabled(env) ? "enabled" : "disabled";
}
