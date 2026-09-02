import express from "express";
import cookieParser from "cookie-parser";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MalwareDetectedError extends Error {}
  class MalwareScanUnavailableError extends Error {}
  class MalwareScanBusyError extends MalwareScanUnavailableError {}
  class MalwareQuarantineCleanupError extends Error {}
  class UploadSecurityRejectedError extends Error {}
  class UploadSecurityUnavailableError extends Error {}
  class UploadSecurityBusyError extends UploadSecurityUnavailableError {}
  class ObjectAlreadyExistsError extends Error {}
  class ObjectNotFoundError extends Error {}
  const storedFile = { name: "private/uploads/test" };
  return {
    provider: "filesystem",
    uploadsEnabled: true,
    actor: { id: 7, role: "employee", facilityId: 3, isActive: true },
    findActiveUploadGrant: vi.fn(),
    reserveUploadGrantForProcessing: vi.fn(),
    processUploadSecurity: vi.fn(),
    finalizeUploadGrantProcessing: vi.fn(),
    reserveUploadGrantFailureCleanup: vi.fn(),
    rollbackUploadGrantProcessing: vi.fn(),
    validateUploadedObject: vi.fn(),
    writeServerMediatedObject: vi.fn(),
    getObjectEntityFile: vi.fn(),
    deleteObject: vi.fn(),
    deleteRejectedGrant: vi.fn(),
    storedFile,
    ObjectAlreadyExistsError,
    ObjectNotFoundError,
    MalwareDetectedError,
    MalwareScanUnavailableError,
    MalwareScanBusyError,
    MalwareQuarantineCleanupError,
    UploadSecurityRejectedError,
    UploadSecurityUnavailableError,
    UploadSecurityBusyError,
  };
});

vi.mock("@workspace/db", () => ({
  credentialsTable: {},
  uploadGrantsTable: {
    id: "id",
    requestedBy: "requestedBy",
    objectPath: "objectPath",
    status: "status",
  },
  db: {
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: mocks.deleteRejectedGrant })),
    })),
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  SESSION_COOKIE: "healthdocs_session",
  MANAGER_ROLES: ["hospital_admin", "system_admin"],
  getUser: vi.fn(() => mocks.actor),
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../lib/helpers", () => ({
  getCredentialScopedUsers: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("../lib/documentUploads", () => ({
  DOCUMENT_UPLOADS_DISABLED_CODE: "DOCUMENT_UPLOADS_DISABLED",
  areDocumentUploadsEnabled: vi.fn(() => mocks.uploadsEnabled),
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit: vi.fn(
    () =>
      (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) =>
        next(),
  ),
}));

vi.mock("../lib/safeError", () => ({
  safeErrorLogFields: vi.fn(() => ({ errorName: "Error" })),
}));

vi.mock("../lib/objectAcl", () => ({
  ObjectPermission: { READ: "read" },
}));

vi.mock("../lib/objectStorage", () => ({
  getObjectStorageProvider: vi.fn(() => mocks.provider),
  ObjectAlreadyExistsError: mocks.ObjectAlreadyExistsError,
  ObjectNotFoundError: mocks.ObjectNotFoundError,
  ObjectStorageService: class {
    writeServerMediatedObject = mocks.writeServerMediatedObject;
    getObjectEntityFile = mocks.getObjectEntityFile;
    deleteObject = mocks.deleteObject;
  },
}));

vi.mock("../lib/uploadSecurity", () => ({
  ALLOWED_UPLOAD_CONTENT_TYPE: /^(?:image\/jpeg|image\/png|application\/pdf)$/,
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  UPLOAD_GRANT_TTL_MS: 15 * 60 * 1000,
  findActiveUploadGrant: mocks.findActiveUploadGrant,
  reserveUploadGrantForProcessing: mocks.reserveUploadGrantForProcessing,
  hasAllowedUploadSignature: vi.fn(() => true),
  processUploadSecurity: mocks.processUploadSecurity,
  finalizeUploadGrantProcessing: mocks.finalizeUploadGrantProcessing,
  reserveUploadGrantFailureCleanup: mocks.reserveUploadGrantFailureCleanup,
  rollbackUploadGrantProcessing: mocks.rollbackUploadGrantProcessing,
  validateUploadedObject: mocks.validateUploadedObject,
  MalwareDetectedError: mocks.MalwareDetectedError,
  MalwareScanUnavailableError: mocks.MalwareScanUnavailableError,
  MalwareScanBusyError: mocks.MalwareScanBusyError,
  MalwareQuarantineCleanupError: mocks.MalwareQuarantineCleanupError,
  UploadSecurityRejectedError: mocks.UploadSecurityRejectedError,
  UploadSecurityUnavailableError: mocks.UploadSecurityUnavailableError,
  UploadSecurityBusyError: mocks.UploadSecurityBusyError,
}));

import router from "./storage";
import { csrfOriginGuard } from "../lib/csrf";

describe("server-mediated private object upload route", () => {
  const uploadId = "f3fddc5a-9315-4b7b-8e7c-8ac98bc9f6c5";
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
    "base64",
  );
  const processedBytes = Buffer.from(
    "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
    "base64",
  );
  const expectedSha256 = createHash("sha256")
    .update(processedBytes)
    .digest("hex");
  let server: ReturnType<express.Express["listen"]> | undefined;
  let origin = "";

  beforeEach(async () => {
    mocks.provider = "filesystem";
    mocks.uploadsEnabled = true;
    mocks.findActiveUploadGrant.mockReset();
    mocks.findActiveUploadGrant.mockResolvedValue({
      id: 19,
      declaredSize: bytes.length,
      declaredContentType: "image/png",
    });
    mocks.reserveUploadGrantForProcessing.mockReset();
    mocks.reserveUploadGrantForProcessing.mockImplementation(
      async (
        objectPath: string,
        requestedBy: number,
        declaredSize: number,
        declaredContentType: string,
        processingToken: string,
      ) => ({
        id: 19,
        objectPath,
        requestedBy,
        declaredSize,
        declaredContentType,
        status: "processing",
        processingToken,
      }),
    );
    mocks.processUploadSecurity.mockReset();
    mocks.processUploadSecurity.mockResolvedValue({
      bytes: processedBytes,
      contentType: "image/jpeg",
      sha256: expectedSha256,
    });
    mocks.finalizeUploadGrantProcessing.mockReset();
    mocks.finalizeUploadGrantProcessing.mockResolvedValue(true);
    mocks.reserveUploadGrantFailureCleanup.mockReset();
    mocks.reserveUploadGrantFailureCleanup.mockResolvedValue(true);
    mocks.rollbackUploadGrantProcessing.mockReset();
    mocks.rollbackUploadGrantProcessing.mockResolvedValue(true);
    mocks.validateUploadedObject.mockReset();
    mocks.validateUploadedObject.mockResolvedValue({
      contentType: "image/jpeg",
      size: processedBytes.length,
      sha256: expectedSha256,
      bytes: processedBytes,
    });
    mocks.writeServerMediatedObject.mockReset();
    mocks.writeServerMediatedObject.mockResolvedValue(undefined);
    mocks.getObjectEntityFile.mockReset();
    mocks.getObjectEntityFile.mockResolvedValue(mocks.storedFile);
    mocks.deleteObject.mockReset();
    mocks.deleteObject.mockResolvedValue(undefined);
    mocks.deleteRejectedGrant.mockReset();
    mocks.deleteRejectedGrant.mockResolvedValue([{ id: 19 }]);

    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, {
        log: { error: vi.fn(), warn: vi.fn() },
      });
      next();
    });
    app.use(cookieParser());
    app.use("/api", csrfOriginGuard, router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function put(
    body = bytes,
    routeHeaders: Record<string, string> = {
      "content-type": "image/png",
      "if-none-match": "*",
    },
    includeClientMarker = true,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      cookie: "healthdocs_session=test-session",
      origin,
      ...routeHeaders,
    };
    if (includeClientMarker) {
      headers["x-requested-with"] = "HealthCredentialHub";
    }
    return fetch(`${origin}/api/storage/uploads/local/${uploadId}`, {
      method: "PUT",
      headers,
      body,
    });
  }

  it("stores only a grant-matching create-only upload", async () => {
    const response = await put();

    expect(response.status).toBe(204);
    expect(mocks.reserveUploadGrantForProcessing).toHaveBeenCalledWith(
      `/objects/uploads/${uploadId}`,
      mocks.actor.id,
      bytes.length,
      "image/png",
      expect.any(String),
    );
    expect(mocks.processUploadSecurity).toHaveBeenCalledWith(
      bytes,
      "image/png",
      { extractPdfText: false },
    );
    expect(mocks.writeServerMediatedObject).toHaveBeenCalledWith(
      `/objects/uploads/${uploadId}`,
      processedBytes,
      "image/jpeg",
      expectedSha256,
    );
    expect(
      mocks.reserveUploadGrantForProcessing.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.processUploadSecurity.mock.invocationCallOrder[0]);
    expect(
      mocks.processUploadSecurity.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeServerMediatedObject.mock.invocationCallOrder[0]);
    expect(mocks.validateUploadedObject).toHaveBeenCalledWith(mocks.storedFile);
    const processingToken = mocks.reserveUploadGrantForProcessing.mock
      .calls[0]?.[4] as string;
    expect(mocks.finalizeUploadGrantProcessing).toHaveBeenCalledWith(
      19,
      mocks.actor.id,
      `/objects/uploads/${uploadId}`,
      processingToken,
      processedBytes.length,
      "image/jpeg",
      expectedSha256,
    );
  });

  it("uses the same guarded path for the generic S3 provider", async () => {
    mocks.provider = "s3";

    const response = await put();

    expect(response.status).toBe(204);
    expect(mocks.writeServerMediatedObject).toHaveBeenCalledWith(
      `/objects/uploads/${uploadId}`,
      processedBytes,
      "image/jpeg",
      expectedSha256,
    );
  });

  it("stores only rebuilt PDF bytes with a PDF grant and finalized digest", async () => {
    const pdfInput = Buffer.from("%PDF-1.7\nsynthetic-original");
    const pdfOutput = Buffer.from("%PDF-1.7\nsynthetic-image-only-output");
    const sha256 = createHash("sha256").update(pdfOutput).digest("hex");
    mocks.processUploadSecurity.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      sha256,
    });
    mocks.validateUploadedObject.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      size: pdfOutput.length,
      sha256,
    });
    const response = await put(pdfInput, {
      "content-type": "application/pdf",
      "if-none-match": "*",
    });
    expect(response.status).toBe(204);
    expect(mocks.processUploadSecurity).toHaveBeenCalledWith(
      pdfInput,
      "application/pdf",
      { extractPdfText: false },
    );
    expect(mocks.writeServerMediatedObject).toHaveBeenCalledWith(
      `/objects/uploads/${uploadId}`,
      pdfOutput,
      "application/pdf",
      sha256,
    );
    expect(mocks.finalizeUploadGrantProcessing).toHaveBeenCalledWith(
      19,
      mocks.actor.id,
      `/objects/uploads/${uploadId}`,
      expect.any(String),
      pdfOutput.length,
      "application/pdf",
      sha256,
    );
  });

  it("returns bounded local PDF suggestions only for the explicit review request", async () => {
    const pdfInput = Buffer.from("%PDF-1.7\nsynthetic-original");
    const pdfOutput = Buffer.from("%PDF-1.7\nsynthetic-image-only-output");
    const sha256 = createHash("sha256").update(pdfOutput).digest("hex");
    mocks.processUploadSecurity.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      sha256,
      extractedText:
        "Saudi Heart Association BLS Certificate Number: 84880082123 Issue Date: 2 Feb 2026 Expiry Date: 2 Feb 2027",
    });
    mocks.validateUploadedObject.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      size: pdfOutput.length,
      sha256,
    });

    const response = await put(pdfInput, {
      "content-type": "application/pdf",
      "if-none-match": "*",
      "x-healthdocs-pdf-text": "review",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-upload-cleanup-disposition")).toBe(
      "confirmed",
    );
    await expect(response.json()).resolves.toMatchObject({
      localExtraction: {
        detectedType: "BLS",
        issuerName: "Saudi Heart Association",
        certificateNumber: "84880082123",
        issueDate: "2026-02-02",
        expiryDate: "2027-02-02",
      },
    });
    expect(mocks.processUploadSecurity).toHaveBeenCalledWith(
      pdfInput,
      "application/pdf",
      { extractPdfText: true },
    );
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
    expect(mocks.finalizeUploadGrantProcessing).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
    expect(mocks.deleteRejectedGrant).toHaveBeenCalledOnce();
  });

  it("returns no-store 204 when an explicitly reviewed PDF has no extractable text", async () => {
    const pdfInput = Buffer.from("%PDF-1.7\nsynthetic-image-only-input");
    const pdfOutput = Buffer.from("%PDF-1.7\nsynthetic-image-only-output");
    const sha256 = createHash("sha256").update(pdfOutput).digest("hex");
    mocks.processUploadSecurity.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      sha256,
    });
    mocks.validateUploadedObject.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      size: pdfOutput.length,
      sha256,
    });

    const response = await put(pdfInput, {
      "content-type": "application/pdf",
      "if-none-match": "*",
      "x-healthdocs-pdf-text": "review",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-upload-cleanup-disposition")).toBe(
      "confirmed",
    );
    expect(mocks.processUploadSecurity).toHaveBeenCalledWith(
      pdfInput,
      "application/pdf",
      { extractPdfText: true },
    );
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
    expect(mocks.finalizeUploadGrantProcessing).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("fails an ephemeral PDF review closed without writing bytes when grant release is uncertain", async () => {
    const pdfInput = Buffer.from("%PDF-1.7\nsynthetic-review-input");
    const pdfOutput = Buffer.from("%PDF-1.7\nsynthetic-review-output");
    const sha256 = createHash("sha256").update(pdfOutput).digest("hex");
    mocks.processUploadSecurity.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      sha256,
      extractedText: "BLS Certificate Number: REVIEW-1234",
    });
    mocks.rollbackUploadGrantProcessing.mockResolvedValue(false);

    const response = await put(pdfInput, {
      "content-type": "application/pdf",
      "if-none-match": "*",
      "x-healthdocs-pdf-text": "review",
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("x-upload-cleanup-disposition")).toBeNull();
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
    expect(mocks.finalizeUploadGrantProcessing).not.toHaveBeenCalled();
  });

  it("never returns PDF suggestions when local review was not requested", async () => {
    const pdfInput = Buffer.from("%PDF-1.7\nsynthetic-original");
    const pdfOutput = Buffer.from("%PDF-1.7\nsynthetic-image-only-output");
    const sha256 = createHash("sha256").update(pdfOutput).digest("hex");
    mocks.processUploadSecurity.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      sha256,
      extractedText: "Certificate Number: MUST-NOT-LEAVE-SERVER",
    });
    mocks.validateUploadedObject.mockResolvedValue({
      bytes: pdfOutput,
      contentType: "application/pdf",
      size: pdfOutput.length,
      sha256,
    });

    const response = await put(pdfInput, {
      "content-type": "application/pdf",
      "if-none-match": "*",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("does not persist rejected active PDF bytes or finalize their grant", async () => {
    mocks.processUploadSecurity.mockRejectedValue(
      new mocks.UploadSecurityRejectedError(),
    );
    const response = await put(
      Buffer.from("%PDF-1.7\nsynthetic-active-content"),
      { "content-type": "application/pdf", "if-none-match": "*" },
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("x-upload-cleanup-disposition")).toBe(
      "confirmed",
    );
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
    expect(mocks.finalizeUploadGrantProcessing).not.toHaveBeenCalled();
  });

  it("fails closed before reading an upload when document intake is disabled", async () => {
    mocks.uploadsEnabled = false;

    const response = await put();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Document uploads are disabled",
      code: "DOCUMENT_UPLOADS_DISABLED",
    });
    expect(mocks.reserveUploadGrantForProcessing).not.toHaveBeenCalled();
    expect(mocks.processUploadSecurity).not.toHaveBeenCalled();
  });

  it("disables upload grants as well as the byte-ingress route", async () => {
    mocks.uploadsEnabled = false;

    const response = await fetch(`${origin}/api/storage/uploads/request-url`, {
      method: "POST",
      headers: {
        cookie: "healthdocs_session=test-session",
        origin,
        "content-type": "application/json",
        "x-requested-with": "HealthCredentialHub",
      },
      body: JSON.stringify({
        name: "credential.png",
        size: bytes.length,
        contentType: "image/png",
      }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Document uploads are disabled",
      code: "DOCUMENT_UPLOADS_DISABLED",
    });
  });

  it("removes a newly stored object when provider-observed validation fails", async () => {
    mocks.validateUploadedObject.mockRejectedValueOnce(
      new Error("stored metadata mismatch"),
    );

    const response = await put();

    expect(response.status).toBe(500);
    expect(response.headers.get("x-upload-cleanup-disposition")).toBe(
      "confirmed",
    );
    expect(mocks.reserveUploadGrantFailureCleanup).toHaveBeenCalledOnce();
    expect(mocks.deleteObject).toHaveBeenCalledWith(mocks.storedFile);
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("removes an object whose provider bytes differ from the screened bytes", async () => {
    mocks.validateUploadedObject.mockResolvedValueOnce({
      contentType: "image/jpeg",
      size: processedBytes.length,
      sha256: "0".repeat(64),
      bytes: Buffer.from(processedBytes),
    });

    const response = await put();

    expect(response.status).toBe(500);
    expect(mocks.reserveUploadGrantFailureCleanup).toHaveBeenCalledOnce();
    expect(mocks.deleteObject).toHaveBeenCalledWith(mocks.storedFile);
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("deletes the processed object only after reserving cleanup when finalization loses its CAS", async () => {
    mocks.finalizeUploadGrantProcessing.mockResolvedValueOnce(false);

    const response = await put();

    expect(response.status).toBe(500);
    expect(mocks.finalizeUploadGrantProcessing).toHaveBeenCalledOnce();
    expect(mocks.reserveUploadGrantFailureCleanup).toHaveBeenCalledOnce();
    expect(mocks.deleteObject).toHaveBeenCalledWith(mocks.storedFile);
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("does not delete a linkable object when an ambiguous finalization already won", async () => {
    mocks.finalizeUploadGrantProcessing.mockRejectedValueOnce(
      new Error("database response lost"),
    );
    mocks.reserveUploadGrantFailureCleanup.mockResolvedValueOnce(false);

    const response = await put();

    expect(response.status).toBe(500);
    expect(response.headers.get("x-upload-cleanup-disposition")).toBeNull();
    expect(mocks.reserveUploadGrantFailureCleanup).toHaveBeenCalledOnce();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).not.toHaveBeenCalled();
  });

  it("preserves an existing object when the create-only write conflicts", async () => {
    mocks.writeServerMediatedObject.mockRejectedValueOnce(
      new mocks.ObjectAlreadyExistsError(),
    );

    const response = await put();

    expect(response.status).toBe(409);
    expect(response.headers.get("x-upload-cleanup-disposition")).toBeNull();
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("preserves an existing filesystem object on an EEXIST conflict", async () => {
    mocks.writeServerMediatedObject.mockRejectedValueOnce(
      Object.assign(new Error("exists"), { code: "EEXIST" }),
    );

    const response = await put();

    expect(response.status).toBe(409);
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("rejects unsafe input before writing any durable object", async () => {
    mocks.processUploadSecurity.mockRejectedValue(
      new mocks.UploadSecurityRejectedError(),
    );

    const response = await put();

    expect(response.status).toBe(422);
    expect(response.headers.get("x-upload-cleanup-disposition")).toBe(
      "confirmed",
    );
    await expect(response.json()).resolves.toEqual({
      error: "Uploaded file failed security checks",
    });
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("fails closed when upload security processing is unavailable", async () => {
    mocks.processUploadSecurity.mockRejectedValue(
      new mocks.UploadSecurityUnavailableError(),
    );

    const response = await put();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Upload security processing is unavailable",
    });
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("does not claim cleanup confirmation when quarantine cleanup failed", async () => {
    mocks.processUploadSecurity.mockRejectedValue(
      new mocks.MalwareQuarantineCleanupError(),
    );

    const response = await put();

    expect(response.status).toBe(503);
    expect(response.headers.get("x-upload-cleanup-disposition")).toBeNull();
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("returns a retryable busy response if the processor slot races after disconnect", async () => {
    mocks.processUploadSecurity.mockRejectedValue(
      new mocks.UploadSecurityBusyError(),
    );

    const response = await put();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: "Upload security processing is busy",
    });
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
    expect(mocks.rollbackUploadGrantProcessing).toHaveBeenCalledOnce();
  });

  it("fails fast before buffering another upload when the processor slot is occupied", async () => {
    let notifyScanStarted: () => void = () => {};
    let releaseScan: () => void = () => {};
    const scanStarted = new Promise<void>((resolve) => {
      notifyScanStarted = resolve;
    });
    const scanRelease = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    mocks.processUploadSecurity.mockImplementationOnce(async () => {
      notifyScanStarted();
      await scanRelease;
      return {
        bytes: processedBytes,
        contentType: "image/jpeg",
        sha256: expectedSha256,
      };
    });

    const first = put();
    await scanStarted;
    expect(mocks.reserveUploadGrantForProcessing).toHaveBeenCalledOnce();
    expect(mocks.finalizeUploadGrantProcessing).not.toHaveBeenCalled();
    const saturated = await put();

    expect(saturated.status).toBe(503);
    expect(saturated.headers.get("retry-after")).toBe("1");
    await expect(saturated.json()).resolves.toEqual({
      error: "Upload security processing is busy",
    });
    expect(mocks.processUploadSecurity).toHaveBeenCalledTimes(1);
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();

    releaseScan();
    expect((await first).status).toBe(204);
    expect(mocks.writeServerMediatedObject).toHaveBeenCalledTimes(1);
  });

  it("rejects uploads without the create-only precondition", async () => {
    const response = await put(bytes, { "content-type": "image/png" });

    expect(response.status).toBe(428);
    expect(mocks.reserveUploadGrantForProcessing).not.toHaveBeenCalled();
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("passes through the application CSRF guard only with the client marker", async () => {
    const response = await put(
      bytes,
      {
        "content-type": "image/png",
        "if-none-match": "*",
      },
      false,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: "Request verification failed",
    });
    expect(mocks.reserveUploadGrantForProcessing).not.toHaveBeenCalled();
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("rejects an expired or cross-user upload grant", async () => {
    mocks.reserveUploadGrantForProcessing.mockResolvedValueOnce(null);

    const response = await put();

    expect(response.status).toBe(403);
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("rejects bytes that do not atomically match the declared grant", async () => {
    mocks.reserveUploadGrantForProcessing.mockResolvedValueOnce(null);

    const response = await put();

    expect(response.status).toBe(403);
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("stays hidden when server-mediated storage is disabled", async () => {
    mocks.provider = "gcs";

    const response = await put();

    expect(response.status).toBe(404);
    expect(mocks.reserveUploadGrantForProcessing).not.toHaveBeenCalled();
  });

  it.each(["gcs", "oci"])(
    "does not mint a direct %s upload capability that bypasses processing",
    async (provider) => {
      mocks.provider = provider;

      const response = await fetch(
        `${origin}/api/storage/uploads/request-url`,
        {
          method: "POST",
          headers: {
            cookie: "healthdocs_session=test-session",
            origin,
            "content-type": "application/json",
            "x-requested-with": "HealthCredentialHub",
          },
          body: JSON.stringify({
            name: "credential.png",
            size: bytes.length,
            contentType: "image/png",
          }),
        },
      );

      expect(response.status).toBe(404);
      expect(mocks.processUploadSecurity).not.toHaveBeenCalled();
    },
  );
});
