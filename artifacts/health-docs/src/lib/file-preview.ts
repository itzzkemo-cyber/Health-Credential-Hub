// Credential files live in object storage and are referenced by an
// "/objects/..." path served through the authenticated API route
// /api/storage/objects/*. The API rejects any other kind of fileUrl (inline
// data: URLs included), so the browser can load files directly from that
// route. Showcase files are the only exception: they are retained in memory
// and resolved to a temporary blob URL that disappears on refresh.

import { isShowcaseMode, resolveShowcaseFile } from "@/demo/showcase";

/** API route that streams stored objects (session-cookie authenticated). */
const STORAGE_API_PREFIX = "/api/storage";

/** Map a stored fileUrl to a URL the browser can load directly. */
export function resolveStoredFileUrl(fileUrl: string): string {
  if (isShowcaseMode) {
    const retained = resolveShowcaseFile(fileUrl);
    if (retained) return retained;
  }
  return fileUrl.startsWith("/objects/")
    ? `${STORAGE_API_PREFIX}${fileUrl}`
    : fileUrl;
}

export function isPdfUrl(fileUrl: string): boolean {
  return /\.pdf($|\?)/i.test(fileUrl);
}

/** Open a stored file in a new tab. Returns false if it could not open. */
export function openFileInNewTab(fileUrl: string): boolean {
  return (
    window.open(
      resolveStoredFileUrl(fileUrl),
      "_blank",
      "noopener,noreferrer",
    ) != null
  );
}
