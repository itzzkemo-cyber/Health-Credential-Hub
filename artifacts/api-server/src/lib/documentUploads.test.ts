import { describe, expect, it } from "vitest";

import {
  areDocumentUploadsEnabled,
  DOCUMENT_UPLOADS_DISABLED_CODE,
  getDocumentUploadReadiness,
} from "./documentUploads";

describe("document upload release gate", () => {
  it("fails closed when production has no explicit opt-in", () => {
    const env = { NODE_ENV: "production" } satisfies NodeJS.ProcessEnv;

    expect(areDocumentUploadsEnabled(env)).toBe(false);
    expect(getDocumentUploadReadiness(env)).toBe("disabled");
    expect(DOCUMENT_UPLOADS_DISABLED_CODE).toBe("DOCUMENT_UPLOADS_DISABLED");
  });

  it("allows an exact production opt-in", () => {
    expect(
      areDocumentUploadsEnabled({
        NODE_ENV: "production",
        DOCUMENT_UPLOADS_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("keeps development and tests enabled by default", () => {
    expect(areDocumentUploadsEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(areDocumentUploadsEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it.each(["false", "invalid", "1", "yes"])(
    "treats %s as disabled",
    (value) => {
      expect(
        areDocumentUploadsEnabled({
          NODE_ENV: "production",
          DOCUMENT_UPLOADS_ENABLED: value,
        }),
      ).toBe(false);
    },
  );
});
