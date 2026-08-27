import { describe, expect, it } from "vitest";
import { buildUploadRequestHeaders } from "./upload";

describe("buildUploadRequestHeaders", () => {
  it("adds the CSRF marker to authenticated same-origin filesystem uploads", () => {
    expect(
      buildUploadRequestHeaders(
        { "if-none-match": "*" },
        "application/pdf",
        "https://app.wathaiqihealth.com/api/storage/uploads/local/id",
        "https://app.wathaiqihealth.com",
      ),
    ).toEqual({
      "if-none-match": "*",
      "Content-Type": "application/pdf",
      "X-Requested-With": "HealthCredentialHub",
    });
  });

  it("does not leak the private CSRF marker to cloud presigned origins", () => {
    const headers = buildUploadRequestHeaders(
      { "x-goog-if-generation-match": "0" },
      "image/jpeg",
      "https://storage.googleapis.com/private-bucket/object?signature=value",
      "https://app.wathaiqihealth.com",
    );

    expect(headers).toEqual({
      "x-goog-if-generation-match": "0",
      "Content-Type": "image/jpeg",
    });
    expect(headers).not.toHaveProperty("X-Requested-With");
  });
});
