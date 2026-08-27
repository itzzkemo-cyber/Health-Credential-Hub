// Prepares user-selected files for upload to object storage.
//
// Phone photos are routinely 5–20 MB; certificates stay perfectly readable
// for document review at 2000px, so images are downscaled/re-encoded in the browser
// before the direct-to-storage upload. PDFs (and images the browser cannot
// decode, e.g. HEIC outside Safari) are uploaded as-is, subject to the size
// cap below. The prepared bytes are PUT straight to the storage presigned
// URL — they never pass through the API server as JSON.

/** Max prepared file size accepted by private document storage (8 MB). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Longest edge of re-encoded document images, in pixels. */
const MAX_IMAGE_EDGE = 2000;
const JPEG_QUALITY = 0.82;

export class UploadTooLargeError extends Error {
  constructor() {
    super("Upload exceeds the maximum allowed size");
    this.name = "UploadTooLargeError";
  }
}

export interface PreparedUpload {
  blob: Blob;
  contentType: string;
  /** Matches the credential fileType field convention. */
  kind: "pdf" | "image";
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
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
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
 * Convert a selected file into upload-ready bytes. Images are downscaled and
 * re-encoded as JPEG (falling back to the original bytes when the browser
 * cannot decode the format); other files pass through unchanged. Throws
 * UploadTooLargeError when the result still exceeds the size cap.
 */
export async function prepareUploadFile(file: File): Promise<PreparedUpload> {
  let blob: Blob | null = null;
  let contentType = file.type || "application/octet-stream";

  if (file.type.startsWith("image/")) {
    try {
      blob = await downscaleImage(file);
      contentType = "image/jpeg";
    } catch {
      blob = null;
      contentType = file.type;
    }
  }
  blob ??= file;

  if (blob.size > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();

  const isPdf =
    contentType === "application/pdf" || /\.pdf$/i.test(file.name);
  return { blob, contentType, kind: isPdf ? "pdf" : "image" };
}
