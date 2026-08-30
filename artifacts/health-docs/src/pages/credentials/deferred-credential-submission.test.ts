import { describe, expect, it, vi } from "vitest";

import {
  claimCredentialSubmission,
  CredentialSubmissionError,
  getUnlinkedUploadId,
  releaseCredentialSubmission,
  submitCredentialWithDeferredUpload,
  type CredentialUploadGrant,
  type PreparedCredentialFile,
} from "./deferred-credential-submission";

const file = new File(["document"], "license.png", {
  type: "image/png",
});
const prepared: PreparedCredentialFile = {
  blob: new Blob(["prepared"], { type: "image/png" }),
  contentType: "image/png",
  kind: "image",
};
const grant: CredentialUploadGrant = {
  uploadURL: "/api/storage/uploads/local/opaque-token",
  objectPath: "/objects/facility/opaque-object",
  requiredHeaders: { "if-none-match": "*" },
};

function createDependencies() {
  return {
    prepareFile: vi.fn(async () => prepared),
    requestUpload: vi.fn(async () => grant),
    putUpload: vi.fn(async () => undefined),
    createCredential: vi.fn(async () => ({ id: 42 })),
    cleanupUpload: vi.fn(async () => undefined),
    onStage: vi.fn(),
  };
}

describe("deferred credential submission", () => {
  it("extracts cleanup identifiers only from canonical private upload paths", () => {
    expect(
      getUnlinkedUploadId(
        "/objects/uploads/123e4567-e89b-42d3-a456-426614174000",
      ),
    ).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(
      getUnlinkedUploadId(
        "/objects/uploads/123e4567-e89b-42d3-a456-426614174000/extra",
      ),
    ).toBeNull();
    expect(
      getUnlinkedUploadId(
        "/objects/uploads/123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBeNull();
    expect(getUnlinkedUploadId("/objects/facility/private.pdf")).toBeNull();
  });

  it("prevents duplicate submissions before React mutation state updates", () => {
    const lock = { current: false };

    expect(claimCredentialSubmission(lock)).toBe(true);
    expect(claimCredentialSubmission(lock)).toBe(false);
    releaseCredentialSubmission(lock);
    expect(claimCredentialSubmission(lock)).toBe(true);
  });

  it("does not prepare or upload an optional file before submission", async () => {
    const dependencies = createDependencies();

    await expect(
      submitCredentialWithDeferredUpload({
        ...dependencies,
        file: null,
      }),
    ).resolves.toEqual({ id: 42 });

    expect(dependencies.prepareFile).not.toHaveBeenCalled();
    expect(dependencies.requestUpload).not.toHaveBeenCalled();
    expect(dependencies.putUpload).not.toHaveBeenCalled();
    expect(dependencies.createCredential).toHaveBeenCalledWith(undefined);
    expect(dependencies.cleanupUpload).not.toHaveBeenCalled();
  });

  it("uploads after submission and passes only the private object reference to create", async () => {
    const dependencies = createDependencies();

    await submitCredentialWithDeferredUpload({
      ...dependencies,
      file,
    });

    expect(dependencies.prepareFile).toHaveBeenCalledWith(file);
    expect(dependencies.requestUpload).toHaveBeenCalledWith(file, prepared);
    expect(dependencies.putUpload).toHaveBeenCalledWith(grant, prepared);
    expect(dependencies.createCredential).toHaveBeenCalledWith({
      objectPath: grant.objectPath,
      kind: "image",
    });
    expect(dependencies.cleanupUpload).not.toHaveBeenCalled();
    expect(dependencies.onStage.mock.calls).toEqual([["upload"], ["create"]]);
  });

  it("preserves PDF kind through the guarded upload and record creation", async () => {
    const dependencies = createDependencies();
    const pdfPrepared: PreparedCredentialFile = {
      blob: new Blob(["synthetic-pdf"]),
      contentType: "application/pdf",
      kind: "pdf",
    };
    dependencies.prepareFile.mockResolvedValue(pdfPrepared);
    await submitCredentialWithDeferredUpload({
      ...dependencies,
      file: new File(["synthetic-pdf"], "credential.pdf", {
        type: "application/pdf",
      }),
    });
    expect(dependencies.putUpload).toHaveBeenCalledWith(grant, pdfPrepared);
    expect(dependencies.createCredential).toHaveBeenCalledWith({
      objectPath: grant.objectPath,
      kind: "pdf",
    });
  });

  it("reuses a reviewed OCR upload without sending the file twice", async () => {
    const dependencies = createDependencies();
    const existingUpload = {
      objectPath: grant.objectPath,
      kind: "image" as const,
    };

    await submitCredentialWithDeferredUpload({
      ...dependencies,
      file,
      existingUpload,
    });

    expect(dependencies.prepareFile).not.toHaveBeenCalled();
    expect(dependencies.requestUpload).not.toHaveBeenCalled();
    expect(dependencies.putUpload).not.toHaveBeenCalled();
    expect(dependencies.createCredential).toHaveBeenCalledWith(existingUpload);
    expect(dependencies.onStage.mock.calls).toEqual([["create"]]);
  });

  it("cleans a reviewed OCR upload when credential creation fails", async () => {
    const dependencies = createDependencies();
    dependencies.createCredential.mockRejectedValueOnce(new Error("rejected"));

    await expect(
      submitCredentialWithDeferredUpload({
        ...dependencies,
        file,
        existingUpload: {
          objectPath: grant.objectPath,
          kind: "image",
        },
      }),
    ).rejects.toMatchObject({
      name: "CredentialSubmissionError",
      stage: "create",
    });

    expect(dependencies.cleanupUpload).toHaveBeenCalledWith(grant.objectPath);
  });

  it("cleans the granted object when credential creation fails", async () => {
    const dependencies = createDependencies();
    dependencies.createCredential.mockRejectedValueOnce(new Error("rejected"));

    await expect(
      submitCredentialWithDeferredUpload({
        ...dependencies,
        file,
      }),
    ).rejects.toMatchObject({
      name: "CredentialSubmissionError",
      stage: "create",
    });

    expect(dependencies.cleanupUpload).toHaveBeenCalledOnce();
    expect(dependencies.cleanupUpload).toHaveBeenCalledWith(grant.objectPath);
  });

  it("cleans after an ambiguous PUT failure once an object path was granted", async () => {
    const dependencies = createDependencies();
    dependencies.putUpload.mockRejectedValueOnce(new Error("network"));

    await expect(
      submitCredentialWithDeferredUpload({
        ...dependencies,
        file,
      }),
    ).rejects.toMatchObject({
      name: "CredentialSubmissionError",
      stage: "upload",
    });

    expect(dependencies.cleanupUpload).toHaveBeenCalledWith(grant.objectPath);
    expect(dependencies.createCredential).not.toHaveBeenCalled();
  });

  it("reports cleanup failure without retaining the object path on the error", async () => {
    const dependencies = createDependencies();
    dependencies.createCredential.mockRejectedValueOnce(new Error("rejected"));
    dependencies.cleanupUpload.mockRejectedValueOnce(new Error("cleanup"));

    let caught: unknown;
    try {
      await submitCredentialWithDeferredUpload({
        ...dependencies,
        file,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CredentialSubmissionError);
    expect(caught).toMatchObject({ stage: "cleanup" });
    expect(caught).not.toHaveProperty("objectPath");
  });
});
