export interface CredentialSubmissionLock {
  current: boolean;
}

export type CredentialSubmissionStage = "upload" | "create" | "cleanup";

export interface PreparedCredentialFile {
  blob: Blob;
  contentType: "image/jpeg" | "image/png" | "application/pdf";
  kind: "image" | "pdf";
}

export interface CredentialUploadGrant {
  uploadURL: string;
  objectPath: string;
  requiredHeaders: Record<string, string>;
}

export interface UploadedCredentialFile {
  objectPath: string;
  kind: "pdf" | "image";
}

export const UPLOAD_CLEANUP_DISPOSITION_HEADER = "x-upload-cleanup-disposition";
export const UPLOAD_CLEANUP_CONFIRMED = "confirmed";

export class CredentialUploadError extends Error {
  readonly status: number;
  readonly cleanupConfirmed: boolean;

  constructor(status: number, cleanupConfirmed: boolean) {
    super(`Storage upload failed (${status})`);
    this.name = "CredentialUploadError";
    this.status = status;
    this.cleanupConfirmed = cleanupConfirmed;
  }
}

export function createCredentialUploadError(
  response: Pick<Response, "status" | "headers">,
): CredentialUploadError {
  return new CredentialUploadError(
    response.status,
    response.headers.get(UPLOAD_CLEANUP_DISPOSITION_HEADER) ===
      UPLOAD_CLEANUP_CONFIRMED,
  );
}

export function isUploadCleanupConfirmed(error: unknown): boolean {
  return error instanceof CredentialUploadError && error.cleanupConfirmed;
}

export class CredentialSubmissionError extends Error {
  readonly stage: CredentialSubmissionStage;
  readonly originalError: unknown;

  constructor(stage: CredentialSubmissionStage, originalError: unknown) {
    super(`Credential submission failed during ${stage}`);
    this.name = "CredentialSubmissionError";
    this.stage = stage;
    this.originalError = originalError;
  }
}

export interface DeferredCredentialSubmissionOptions<TResult> {
  file: File | null;
  existingUpload?: UploadedCredentialFile;
  prepareFile: (file: File) => Promise<PreparedCredentialFile>;
  requestUpload: (
    file: File,
    prepared: PreparedCredentialFile,
  ) => Promise<CredentialUploadGrant>;
  putUpload: (
    grant: CredentialUploadGrant,
    prepared: PreparedCredentialFile,
  ) => Promise<void>;
  createCredential: (
    uploadedFile: UploadedCredentialFile | undefined,
  ) => Promise<TResult>;
  cleanupUpload: (objectPath: string) => Promise<void>;
  onStage?: (stage: Exclude<CredentialSubmissionStage, "cleanup">) => void;
}

/**
 * Claims the submission synchronously. Mutation state updates on the next
 * render, so a ref-backed lock closes the double-click window.
 */
export function claimCredentialSubmission(
  lock: CredentialSubmissionLock,
): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseCredentialSubmission(
  lock: CredentialSubmissionLock,
): void {
  lock.current = false;
}

export function getUnlinkedUploadId(objectPath: string): string | null {
  return (
    /^\/objects\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
      objectPath,
    )?.[1] ?? null
  );
}

/**
 * Uploads only after the caller has completed form validation, then creates
 * the credential. Once an object path has been granted, every later failure
 * attempts idempotent cleanup so a network ambiguity or create failure cannot
 * leave an unlinked private object behind.
 */
export async function submitCredentialWithDeferredUpload<TResult>({
  file,
  existingUpload,
  prepareFile,
  requestUpload,
  putUpload,
  createCredential,
  cleanupUpload,
  onStage,
}: DeferredCredentialSubmissionOptions<TResult>): Promise<TResult> {
  let objectPath = existingUpload?.objectPath;
  let uploadedFile = existingUpload;
  let failedStage: Exclude<CredentialSubmissionStage, "cleanup"> = "create";

  try {
    if (file && !uploadedFile) {
      failedStage = "upload";
      onStage?.("upload");
      const prepared = await prepareFile(file);
      const grant = await requestUpload(file, prepared);
      objectPath = grant.objectPath;
      await putUpload(grant, prepared);
      uploadedFile = { objectPath, kind: prepared.kind };
    }

    failedStage = "create";
    onStage?.("create");
    return await createCredential(uploadedFile);
  } catch (error) {
    const serverConfirmedUploadCleanup =
      failedStage === "upload" &&
      isUploadCleanupConfirmed(error);
    if (objectPath && !serverConfirmedUploadCleanup) {
      try {
        await cleanupUpload(objectPath);
      } catch (cleanupError) {
        throw new CredentialSubmissionError("cleanup", cleanupError);
      }
    }
    throw new CredentialSubmissionError(failedStage, error);
  }
}
