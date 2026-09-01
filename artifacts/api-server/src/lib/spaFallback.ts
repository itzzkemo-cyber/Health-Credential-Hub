/**
 * Browser navigation and email link scanners can probe a destination with
 * HEAD before following it with GET. Both methods must resolve to the same SPA
 * document, while API/non-HTML requests continue to the normal 404 handler.
 */
export function isSpaDocumentRequest(
  method: string,
  acceptsHtml: boolean,
): boolean {
  return (method === "GET" || method === "HEAD") && acceptsHtml;
}
