// Credential files live in object storage and are referenced by an
// "/objects/..." path served through the authenticated API route
// /api/storage/objects/*. The API rejects any other kind of fileUrl (inline
// data: URLs included), so the browser can always load files directly from
// that route — no data:/blob: conversion machinery is needed.

/** API route that streams stored objects (session-cookie authenticated). */
const STORAGE_API_PREFIX = "/api/storage";

/** Map a stored fileUrl to a URL the browser can load directly. */
export function resolveStoredFileUrl(fileUrl: string): string {
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
