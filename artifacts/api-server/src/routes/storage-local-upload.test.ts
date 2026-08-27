import express from "express";
import cookieParser from "cookie-parser";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MalwareDetectedError extends Error {}
  class MalwareScanUnavailableError extends Error {}
  class MalwareScanBusyError extends MalwareScanUnavailableError {}
  class MalwareQuarantineCleanupError extends Error {}
  class ObjectAlreadyExistsError extends Error {}
  const storedFile = { name: "private/uploads/test" };
  return {
    provider: "filesystem",
    uploadsEnabled: true,
    actor: { id: 7, role: "employee", facilityId: 3, isActive: true },
    findActiveUploadGrant: vi.fn(),
    scanUploadForMalware: vi.fn(),
    validateUploadedObject: vi.fn(),
    writeServerMediatedObject: vi.fn(),
    getObjectEntityFile: vi.fn(),
    deleteObject: vi.fn(),
    storedFile,
    ObjectAlreadyExistsError,
    MalwareDetectedError,
    MalwareScanUnavailableError,
    MalwareScanBusyError,
    MalwareQuarantineCleanupError,
  };
});

vi.mock("@workspace/db", () => ({
  credentialsTable: {},
  uploadGrantsTable: {},
  db: {},
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
  ObjectNotFoundError: class extends Error {},
  ObjectStorageService: class {
    writeServerMediatedObject = mocks.writeServerMediatedObject;
    getObjectEntityFile = mocks.getObjectEntityFile;
    deleteObject = mocks.deleteObject;
  },
}));

vi.mock("../lib/uploadSecurity", () => ({
  ALLOWED_UPLOAD_CONTENT_TYPE:
    /^(?:application\/pdf|image\/(?:jpeg|png|webp))$/,
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  UPLOAD_GRANT_TTL_MS: 15 * 60 * 1000,
  findActiveUploadGrant: mocks.findActiveUploadGrant,
  hasAllowedUploadSignature: vi.fn(() => true),
  scanUploadForMalware: mocks.scanUploadForMalware,
  validateUploadedObject: mocks.validateUploadedObject,
  MalwareDetectedError: mocks.MalwareDetectedError,
  MalwareScanUnavailableError: mocks.MalwareScanUnavailableError,
  MalwareScanBusyError: mocks.MalwareScanBusyError,
  MalwareQuarantineCleanupError: mocks.MalwareQuarantineCleanupError,
}));

import router from "./storage";
import { csrfOriginGuard } from "../lib/csrf";

describe("server-mediated private object upload route", () => {
  const uploadId = "f3fddc5a-9315-4b7b-8e7c-8ac98bc9f6c5";
  const bytes = Buffer.from("%PDF-1.7\nprivate credential", "utf8");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  let server: ReturnType<express.Express["listen"]> | undefined;
  let origin = "";

  beforeEach(async () => {
    mocks.provider = "filesystem";
    mocks.uploadsEnabled = true;
    mocks.findActiveUploadGrant.mockReset();
    mocks.findActiveUploadGrant.mockResolvedValue({
      declaredSize: bytes.length,
      declaredContentType: "application/pdf",
    });
    mocks.scanUploadForMalware.mockReset();
    mocks.scanUploadForMalware.mockResolvedValue(undefined);
    mocks.validateUploadedObject.mockReset();
    mocks.validateUploadedObject.mockResolvedValue({
      contentType: "application/pdf",
      size: bytes.length,
      sha256: expectedSha256,
      bytes,
    });
    mocks.writeServerMediatedObject.mockReset();
    mocks.writeServerMediatedObject.mockResolvedValue(undefined);
    mocks.getObjectEntityFile.mockReset();
    mocks.getObjectEntityFile.mockResolvedValue(mocks.storedFile);
    mocks.deleteObject.mockReset();
    mocks.deleteObject.mockResolvedValue(undefined);

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
      "content-type": "application/pdf",
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
    expect(mocks.findActiveUploadGrant).toHaveBeenCalledWith(
      `/objects/uploads/${uploadId}`,
      mocks.actor.id,
    );
    expect(mocks.scanUploadForMalware).toHaveBeenCalledWith(bytes);
    expect(mocks.writeServerMediatedObject).toHaveBeenCalledWith(
      `/objects/uploads/${uploadId}`,
      bytes,
      "application/pdf",
      expectedSha256,
    );
    expect(mocks.scanUploadForMalware.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeServerMediatedObject.mock.invocationCallOrder[0],
    );
    expect(mocks.validateUploadedObject).toHaveBeenCalledWith(
      mocks.storedFile,
      expect.objectContaining({
        declaredSize: bytes.length,
        declaredContentType: "application/pdf",
      }),
    );
  });

  it("uses the same guarded path for the generic S3 provider", async () => {
    mocks.provider = "s3";

    const response = await put();

    expect(response.status).toBe(204);
    expect(mocks.writeServerMediatedObject).toHaveBeenCalledWith(
      `/objects/uploads/${uploadId}`,
      bytes,
      "application/pdf",
      expectedSha256,
    );
  });

  it("fails closed before reading an upload when document intake is disabled", async () => {
    mocks.uploadsEnabled = false;

    const response = await put();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Document uploads are disabled",
      code: "DOCUMENT_UPLOADS_DISABLED",
    });
    expect(mocks.findActiveUploadGrant).not.toHaveBeenCalled();
    expect(mocks.scanUploadForMalware).not.toHaveBeenCalled();
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
        name: "credential.pdf",
        size: bytes.length,
        contentType: "application/pdf",
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
    expect(mocks.deleteObject).toHaveBeenCalledWith(mocks.storedFile);
  });

  it("removes an object whose provider bytes differ from the screened bytes", async () => {
    mocks.validateUploadedObject.mockResolvedValueOnce({
      contentType: "application/pdf",
      size: bytes.length,
      sha256: "0".repeat(64),
      bytes: Buffer.from(bytes),
    });

    const response = await put();

    expect(response.status).toBe(500);
    expect(mocks.deleteObject).toHaveBeenCalledWith(mocks.storedFile);
  });

  it("preserves an existing object when the create-only write conflicts", async () => {
    mocks.writeServerMediatedObject.mockRejectedValueOnce(
      new mocks.ObjectAlreadyExistsError(),
    );

    const response = await put();

    expect(response.status).toBe(409);
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it("rejects infected bytes before writing an object", async () => {
    mocks.scanUploadForMalware.mockRejectedValue(
      new mocks.MalwareDetectedError(),
    );

    const response = await put();

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Uploaded file failed security checks",
    });
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("fails closed when the malware scanner is unavailable", async () => {
    mocks.scanUploadForMalware.mockRejectedValue(
      new mocks.MalwareScanUnavailableError(),
    );

    const response = await put();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Upload security scanning is unavailable",
    });
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("returns a retryable busy response if the scanner slot races after disconnect", async () => {
    mocks.scanUploadForMalware.mockRejectedValue(
      new mocks.MalwareScanBusyError(),
    );

    const response = await put();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: "Upload security scanning is busy",
    });
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("fails fast before buffering another upload when the scanner slot is occupied", async () => {
    let notifyScanStarted: () => void = () => {};
    let releaseScan: () => void = () => {};
    const scanStarted = new Promise<void>((resolve) => {
      notifyScanStarted = resolve;
    });
    const scanRelease = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    mocks.scanUploadForMalware.mockImplementationOnce(async () => {
      notifyScanStarted();
      await scanRelease;
    });

    const first = put();
    await scanStarted;
    const saturated = await put();

    expect(saturated.status).toBe(503);
    expect(saturated.headers.get("retry-after")).toBe("1");
    await expect(saturated.json()).resolves.toEqual({
      error: "Upload security scanning is busy",
    });
    expect(mocks.scanUploadForMalware).toHaveBeenCalledTimes(1);
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();

    releaseScan();
    expect((await first).status).toBe(204);
    expect(mocks.writeServerMediatedObject).toHaveBeenCalledTimes(1);
  });

  it("rejects uploads without the create-only precondition", async () => {
    const response = await put(bytes, { "content-type": "application/pdf" });

    expect(response.status).toBe(428);
    expect(mocks.findActiveUploadGrant).not.toHaveBeenCalled();
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("passes through the application CSRF guard only with the client marker", async () => {
    const response = await put(
      bytes,
      {
        "content-type": "application/pdf",
        "if-none-match": "*",
      },
      false,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: "Request verification failed",
    });
    expect(mocks.findActiveUploadGrant).not.toHaveBeenCalled();
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("rejects an expired or cross-user upload grant", async () => {
    mocks.findActiveUploadGrant.mockResolvedValue(null);

    const response = await put();

    expect(response.status).toBe(403);
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("rejects bytes that do not match the declared grant", async () => {
    mocks.findActiveUploadGrant.mockResolvedValue({
      declaredSize: bytes.length + 1,
      declaredContentType: "application/pdf",
    });

    const response = await put();

    expect(response.status).toBe(400);
    expect(mocks.writeServerMediatedObject).not.toHaveBeenCalled();
  });

  it("stays hidden when server-mediated storage is disabled", async () => {
    mocks.provider = "gcs";

    const response = await put();

    expect(response.status).toBe(404);
    expect(mocks.findActiveUploadGrant).not.toHaveBeenCalled();
  });
});
