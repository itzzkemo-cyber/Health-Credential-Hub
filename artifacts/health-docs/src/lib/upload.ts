// Prepares user-selected files for upload to object storage.
//
// Phone photos are routinely 5–20 MB; certificates stay readable for review
// at 2000px, so supported images are downscaled/re-encoded in the browser
// before the controlled private-object upload. PDFs are handed only to the
// server-side bounded image-only PDF rebuilder; no browser parser or external
// service receives them. The server independently verifies all upload bytes.

/** Max prepared file size accepted by private document storage (8 MB). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export const ACCEPTED_UPLOAD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
] as const;

export type AcceptedUploadMimeType =
  (typeof ACCEPTED_UPLOAD_MIME_TYPES)[number];

export const UPLOAD_ACCEPT_ATTRIBUTE = ACCEPTED_UPLOAD_MIME_TYPES.join(",");

/** Longest edge of re-encoded document images, in pixels. */
const MAX_IMAGE_EDGE = 2000;
const JPEG_QUALITY = 0.82;

export class UploadTooLargeError extends Error {
  constructor() {
    super("Upload exceeds the maximum allowed size");
    this.name = "UploadTooLargeError";
  }
}

export class UnsupportedUploadTypeError extends Error {
  constructor() {
    super("Upload type is not supported");
    this.name = "UnsupportedUploadTypeError";
  }
}

export interface PreparedUpload {
  blob: Blob;
  contentType: AcceptedUploadMimeType;
  kind: "image" | "pdf";
}

export function isSupportedUploadFile(file: Pick<File, "type">): boolean {
  return ACCEPTED_UPLOAD_MIME_TYPES.includes(
    file.type as (typeof ACCEPTED_UPLOAD_MIME_TYPES)[number],
  );
}

/**
 * Build headers for the direct object upload. Same-origin filesystem uploads
 * use the authenticated session cookie, so they must carry the application's
 * CSRF marker. Cloud presigned URLs are cross-origin and must not receive that
 * private marker (or require it in bucket CORS/signing rules).
 */
export function buildUploadRequestHeaders(
  requiredHeaders: Record<string, string>,
  contentType: string,
  uploadUrl: string,
  pageOrigin: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...requiredHeaders,
    "Content-Type": contentType,
  };
  const targetOrigin = new URL(uploadUrl, pageOrigin).origin;
  if (targetOrigin === new URL(pageOrigin).origin) {
    headers["X-Requested-With"] = "HealthCredentialHub";
  }
  return headers;
}

function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Canvas encoding failed")),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

async function downscaleImage(file: File): Promise<Blob> {
  // imageOrientation: "from-image" bakes EXIF rotation into the pixels so
  // sideways phone photos come out upright.
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const scale = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    // JPEG has no alpha channel: paint a white background first so
    // transparent PNG scans stay legible instead of turning black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await canvasToJpegBlob(canvas);
  } finally {
    bitmap.close();
  }
}

/**
 * Convert a selected JPEG/PNG into upload-ready bytes. Images are downscaled
 * and re-encoded as JPEG (falling back to the original allowed bytes when the
 * browser cannot decode them). Unsupported types fail before any processing;
 * UploadTooLargeError is thrown when the prepared image exceeds the size cap.
 */
export async function prepareUploadFile(file: File): Promise<PreparedUpload> {
  if (!isSupportedUploadFile(file)) throw new UnsupportedUploadTypeError();

  if (file.type === "application/pdf") {
    if (file.size > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();
    return { blob: file, contentType: "application/pdf", kind: "pdf" };
  }

  let blob: Blob | null = null;
  let contentType = file.type as AcceptedUploadMimeType;

  try {
    blob = await downscaleImage(file);
    contentType = "image/jpeg";
  } catch {
    blob = null;
    contentType = file.type as AcceptedUploadMimeType;
  }
  blob ??= file;

  if (blob.size > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();

  return { blob, contentType, kind: "image" };
}
