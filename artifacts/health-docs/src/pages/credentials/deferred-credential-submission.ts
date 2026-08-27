export interface CredentialSubmissionLock {
  current: boolean;
}

export type CredentialSubmissionStage = "upload" | "create" | "cleanup";

export interface PreparedCredentialFile {
  blob: Blob;
  contentType: string;
  kind: "pdf" | "image";
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
  return /^\/objects\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
    objectPath,
  )?.[1] ?? null;
}

/**
 * Uploads only after the caller has completed form validation, then creates
 * the credential. Once an object path has been granted, every later failure
 * attempts idempotent cleanup so a network ambiguity or create failure cannot
 * leave an unlinked private object behind.
 */
export async function submitCredentialWithDeferredUpload<TResult>({
  file,
  prepareFile,
  requestUpload,
  putUpload,
  createCredential,
  cleanupUpload,
  onStage,
}: DeferredCredentialSubmissionOptions<TResult>): Promise<TResult> {
  let objectPath: string | undefined;
  let uploadedFile: UploadedCredentialFile | undefined;
  let failedStage: Exclude<CredentialSubmissionStage, "cleanup"> = "create";

  try {
    if (file) {
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
    if (objectPath) {
      try {
        await cleanupUpload(objectPath);
      } catch (cleanupError) {
        throw new CredentialSubmissionError("cleanup", cleanupError);
      }
    }
    throw new CredentialSubmissionError(failedStage, error);
  }
}
