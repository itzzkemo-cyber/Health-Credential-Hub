const SAFE_ERROR_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

export interface SafeErrorLogFields {
  errorName: string;
  errorCode?: string;
}

/**
 * Reduce arbitrary database/provider failures to a bounded classification.
 *
 * Error messages, stacks, causes and custom SDK properties are deliberately
 * excluded: those objects can contain SQL parameters, recipient addresses,
 * object paths, request headers, or presigned URLs. The returned value is safe
 * to pass to Pino or persist as an operator-facing failure classification.
 */
export function safeErrorLogFields(error: unknown): SafeErrorLogFields {
  let candidateName = "UnknownError";
  let candidateCode: unknown;
  try {
    if (error instanceof Error) {
      candidateName = error.name;
    } else if (error && typeof error === "object") {
      candidateName = String((error as { name?: unknown }).name ?? candidateName);
    }
    candidateCode =
      error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
  } catch {
    // Some provider objects expose throwing getters. Treat them as opaque.
    return { errorName: "UnknownError" };
  }

  const errorName = SAFE_ERROR_IDENTIFIER.test(candidateName)
    ? candidateName
    : "UnknownError";
  const errorCode =
    typeof candidateCode === "string" &&
    SAFE_ERROR_CODE.test(candidateCode)
      ? candidateCode
      : undefined;
  return errorCode ? { errorName, errorCode } : { errorName };
}

export const safeErrorSerializers = {
  err: safeErrorLogFields,
  error: safeErrorLogFields,
};
