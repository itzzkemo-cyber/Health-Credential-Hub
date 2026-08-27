import { describe, expect, it } from "vitest";
import {
  buildUploadRequestHeaders,
  isSupportedUploadFile,
  MAX_UPLOAD_BYTES,
  prepareUploadFile,
  UnsupportedUploadTypeError,
  UploadTooLargeError,
  UPLOAD_ACCEPT_ATTRIBUTE,
} from "./upload";

describe("buildUploadRequestHeaders", () => {
  it("adds the CSRF marker to authenticated same-origin filesystem uploads", () => {
    expect(
      buildUploadRequestHeaders(
        { "if-none-match": "*" },
        "image/png",
        "https://app.wathaiqihealth.com/api/storage/uploads/local/id",
        "https://app.wathaiqihealth.com",
      ),
    ).toEqual({
      "if-none-match": "*",
      "Content-Type": "image/png",
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

describe("controlled image uploads", () => {
  it("advertises and accepts only JPEG and PNG files", () => {
    expect(UPLOAD_ACCEPT_ATTRIBUTE).toBe("image/jpeg,image/png");
    expect(isSupportedUploadFile({ type: "image/jpeg" })).toBe(true);
    expect(isSupportedUploadFile({ type: "image/png" })).toBe(true);
    expect(isSupportedUploadFile({ type: "application/pdf" })).toBe(false);
    expect(isSupportedUploadFile({ type: "image/webp" })).toBe(false);
    expect(isSupportedUploadFile({ type: "" })).toBe(false);
  });

  it("rejects PDF before upload preparation", async () => {
    const pdf = new File(["document"], "license.pdf", {
      type: "application/pdf",
    });

    await expect(prepareUploadFile(pdf)).rejects.toBeInstanceOf(
      UnsupportedUploadTypeError,
    );
  });

  it("keeps a supported original image when decoding is unavailable", async () => {
    const png = new File(["image"], "license.png", { type: "image/png" });

    await expect(prepareUploadFile(png)).resolves.toMatchObject({
      blob: png,
      contentType: "image/png",
      kind: "image",
    });
  });

  it("rejects an allowed image that remains over 8 MB", async () => {
    const jpeg = new File(
      [new Uint8Array(MAX_UPLOAD_BYTES + 1)],
      "large-license.jpg",
      { type: "image/jpeg" },
    );

    await expect(prepareUploadFile(jpeg)).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
  });
});
