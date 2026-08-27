import { describe, expect, it } from "vitest";

import { getDocumentUploadAvailability } from "./document-upload-availability";

describe("document upload availability", () => {
  it("enables file selection only after an explicit enabled response", () => {
    expect(
      getDocumentUploadAvailability({
        readiness: {
          status: "ready",
          database: "ready",
          objectStorage: "ready",
          documentUploads: "enabled",
        },
        isLoading: false,
        isError: false,
      }),
    ).toBe("enabled");
  });

  it("fails closed while checking, when disabled, and on readiness errors", () => {
    expect(
      getDocumentUploadAvailability({ isLoading: true, isError: false }),
    ).toBe("checking");
    expect(
      getDocumentUploadAvailability({
        readiness: {
          status: "ready",
          database: "ready",
          objectStorage: "ready",
          documentUploads: "disabled",
        },
        isLoading: false,
        isError: false,
      }),
    ).toBe("disabled");
    expect(
      getDocumentUploadAvailability({ isLoading: false, isError: true }),
    ).toBe("unavailable");
  });
});
