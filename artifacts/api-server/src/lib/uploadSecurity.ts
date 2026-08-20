import type { StoredObjectFile } from "./objectStorage";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, uploadGrantsTable, type UploadGrant } from "@workspace/db";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const ALLOWED_UPLOAD_CONTENT_TYPE =
  /^(image\/(png|jpe?g|webp|gif|avif|heic|heif)|application\/pdf)$/i;
export const UPLOAD_GRANT_TTL_MS = 15 * 60 * 1000;

export async function findActiveUploadGrant(
  objectPath: string,
  requestedBy: number,
): Promise<UploadGrant | null> {
  const rows = await db
    .select()
    .from(uploadGrantsTable)
    .where(
      and(
        eq(uploadGrantsTable.objectPath, objectPath),
        eq(uploadGrantsTable.requestedBy, requestedBy),
        isNull(uploadGrantsTable.claimedAt),
        gt(uploadGrantsTable.expiresAt, new Date()),
      ),
    );
  return rows[0] ?? null;
}

/**
 * Verify server-observed object metadata, never just the values declared by
 * the browser before upload. Exact matching also ensures a presigned URL is
 * used for the file that was approved, not a substituted larger payload.
 */
export async function validateUploadedObject(
  objectFile: StoredObjectFile,
  grant?: UploadGrant | null,
): Promise<{ contentType: string; size: number }> {
  const [metadata] = await objectFile.getMetadata();
  const contentType = String(metadata.contentType ?? "").toLowerCase();
  const size = Number(metadata.size ?? 0);

  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_UPLOAD_BYTES ||
    !ALLOWED_UPLOAD_CONTENT_TYPE.test(contentType)
  ) {
    throw new Error("Stored object violates the upload policy");
  }
  if (
    grant &&
    (size !== grant.declaredSize ||
      contentType !== grant.declaredContentType.toLowerCase())
  ) {
    throw new Error("Stored object metadata does not match its upload grant");
  }
  return { contentType, size };
}

export async function consumeUploadGrant(grantId: number): Promise<boolean> {
  const rows = await db
    .update(uploadGrantsTable)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(uploadGrantsTable.id, grantId),
        isNull(uploadGrantsTable.claimedAt),
        gt(uploadGrantsTable.expiresAt, new Date()),
      ),
    )
    .returning({ id: uploadGrantsTable.id });
  return rows.length === 1;
}
