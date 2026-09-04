import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  buildUploadRequestHeaders,
  InvalidPdfError,
  isSupportedUploadFile,
  MAX_PDF_PAGES,
  MAX_UPLOAD_BYTES,
  PdfPageLimitError,
  prepareUploadFile,
  UnsupportedUploadTypeError,
  UploadTooLargeError,
  UPLOAD_ACCEPT_ATTRIBUTE,
  validateUploadFile,
} from "./upload";

async function makePdf(pageCount: number): Promise<File> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage();
  const bytes = await document.save();
  return new File([bytes], `credential-${pageCount}-pages.pdf`, {
    type: "application/pdf",
  });
}

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

describe("controlled document uploads", () => {
  it("advertises and accepts only JPEG, PNG and PDF files", () => {
    expect(UPLOAD_ACCEPT_ATTRIBUTE).toBe(
      "image/jpeg,image/png,application/pdf",
    );
    expect(isSupportedUploadFile({ type: "image/jpeg" })).toBe(true);
    expect(isSupportedUploadFile({ type: "image/png" })).toBe(true);
    expect(isSupportedUploadFile({ type: "application/pdf" })).toBe(true);
    expect(isSupportedUploadFile({ type: "image/webp" })).toBe(false);
    expect(isSupportedUploadFile({ type: "" })).toBe(false);
  });

  it("sends PDF only to controlled server processing without image decoding", async () => {
    const pdf = await makePdf(1);

    await expect(prepareUploadFile(pdf)).resolves.toEqual({
      blob: pdf,
      contentType: "application/pdf",
      kind: "pdf",
    });
  });

  it("rejects a PDF larger than 8 MiB before network upload", async () => {
    const pdf = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "large.pdf", {
      type: "application/pdf",
    });
    await expect(prepareUploadFile(pdf)).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
  });

  it("accepts a PDF at the five-page client limit", async () => {
    const pdf = await makePdf(MAX_PDF_PAGES);

    await expect(validateUploadFile(pdf)).resolves.toBeUndefined();
  });

  it("rejects a PDF over five pages before network upload", async () => {
    const pdf = await makePdf(MAX_PDF_PAGES + 1);

    await expect(validateUploadFile(pdf)).rejects.toMatchObject({
      name: PdfPageLimitError.name,
      pageCount: MAX_PDF_PAGES + 1,
    });
  });

  it("rejects a malformed PDF during client-side validation", async () => {
    const pdf = new File(["not-a-pdf"], "broken.pdf", {
      type: "application/pdf",
    });

    await expect(validateUploadFile(pdf)).rejects.toBeInstanceOf(
      InvalidPdfError,
    );
  });

  it("rejects unsupported active types before upload", async () => {
    const html = new File(["<script>"], "document.html", { type: "text/html" });
    await expect(prepareUploadFile(html)).rejects.toBeInstanceOf(
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
