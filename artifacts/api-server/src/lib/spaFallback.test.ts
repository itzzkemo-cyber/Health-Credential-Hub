import { describe, expect, it } from "vitest";
import { isSpaDocumentRequest } from "./spaFallback";

describe("SPA document fallback", () => {
  it.each(["GET", "HEAD"])("serves HTML navigation for %s", (method) => {
    expect(isSpaDocumentRequest(method, true)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "does not treat %s as an SPA navigation",
    (method) => {
      expect(isSpaDocumentRequest(method, true)).toBe(false);
    },
  );

  it("does not serve the SPA to non-HTML probes", () => {
    expect(isSpaDocumentRequest("GET", false)).toBe(false);
    expect(isSpaDocumentRequest("HEAD", false)).toBe(false);
  });
});
