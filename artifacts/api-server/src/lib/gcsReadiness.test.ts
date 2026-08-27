import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  checkObjectStorageReadiness,
  ObjectStorageReadinessError,
} from "./gcsReadiness";

const productionEnv = {
  NODE_ENV: "production",
  OBJECT_STORAGE_PROVIDER: "gcs",
  GOOGLE_CLOUD_PROJECT: "health-project",
  PRIVATE_OBJECT_DIR: "/health-private/private",
} satisfies NodeJS.ProcessEnv;

const secureMetadata = {
  name: "health-private",
  location: "ME-CENTRAL2",
  iamConfiguration: {
    publicAccessPrevention: "enforced",
    uniformBucketLevelAccess: { enabled: true },
  },
};

const absoluteFilesystemRoot = path.resolve(
  path.parse(process.cwd()).root,
  "wathaiqi-health-tests",
  "objects",
);

describe("GCS production readiness", () => {
  it("does not contact GCS outside production", async () => {
    const readBucketMetadata = vi.fn();

    await expect(
      checkObjectStorageReadiness({
        env: {
          NODE_ENV: "development",
          PRIVATE_OBJECT_DIR: "/local-placeholder/private",
        },
        readBucketMetadata,
      }),
    ).resolves.toBe("configured");
    expect(readBucketMetadata).not.toHaveBeenCalled();
  });

  it("requires a private object directory in every environment", async () => {
    await expect(
      checkObjectStorageReadiness({ env: { NODE_ENV: "test" } }),
    ).rejects.toBeInstanceOf(ObjectStorageReadinessError);
  });

  it("requires an explicit provider in production", async () => {
    const { OBJECT_STORAGE_PROVIDER: _provider, ...envWithoutProvider } =
      productionEnv;

    await expect(
      checkObjectStorageReadiness({
        env: envWithoutProvider,
        readBucketMetadata: vi.fn(),
      }),
    ).rejects.toThrow("Object storage provider is not configured");
  });

  it("verifies accessible secure bucket metadata without a write probe", async () => {
    const readBucketMetadata = vi.fn().mockResolvedValue(secureMetadata);

    await expect(
      checkObjectStorageReadiness({
        env: productionEnv,
        readBucketMetadata,
      }),
    ).resolves.toBe("verified");
    expect(readBucketMetadata).toHaveBeenCalledOnce();
    expect(readBucketMetadata).toHaveBeenCalledWith("health-private");
  });

  it("fails closed when the bucket cannot be read", async () => {
    const readBucketMetadata = vi
      .fn()
      .mockRejectedValue(new Error("permission denied"));

    await expect(
      checkObjectStorageReadiness({
        env: productionEnv,
        readBucketMetadata,
      }),
    ).rejects.toThrow("permission denied");
  });

  it.each([
    ["a malformed private directory", { PRIVATE_OBJECT_DIR: "/bucket/wrong" }],
    ["a missing project", { GOOGLE_CLOUD_PROJECT: "" }],
    ["an unsupported provider", { OBJECT_STORAGE_PROVIDER: "filesystem" }],
  ])("rejects %s", async (_caseName, overrides) => {
    await expect(
      checkObjectStorageReadiness({
        env: { ...productionEnv, ...overrides },
        readBucketMetadata: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(ObjectStorageReadinessError);
  });

  it.each([
    ["a mismatched bucket", { ...secureMetadata, name: "other-bucket" }],
    ["the wrong region", { ...secureMetadata, location: "US" }],
    [
      "disabled public access prevention",
      {
        ...secureMetadata,
        iamConfiguration: {
          ...secureMetadata.iamConfiguration,
          publicAccessPrevention: "inherited",
        },
      },
    ],
    [
      "disabled uniform bucket-level access",
      {
        ...secureMetadata,
        iamConfiguration: {
          ...secureMetadata.iamConfiguration,
          uniformBucketLevelAccess: { enabled: false },
        },
      },
    ],
  ])("rejects %s", async (_caseName, metadata) => {
    await expect(
      checkObjectStorageReadiness({
        env: productionEnv,
        readBucketMetadata: vi.fn().mockResolvedValue(metadata),
      }),
    ).rejects.toBeInstanceOf(ObjectStorageReadinessError);
  });

  it("verifies OCI Riyadh configuration and bucket reachability", async () => {
    const readBucketMetadata = vi.fn();
    const probeOciBucket = vi.fn().mockResolvedValue(undefined);

    await expect(
      checkObjectStorageReadiness({
        env: {
          ...productionEnv,
          OBJECT_STORAGE_PROVIDER: "oci",
          OCI_OBJECT_STORAGE_REGION: "me-riyadh-1",
          OCI_OBJECT_STORAGE_ENDPOINT:
            "https://tenantns.compat.objectstorage.me-riyadh-1.oraclecloud.com",
          OCI_OBJECT_STORAGE_ACCESS_KEY_ID: "test-access-key",
          OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
        },
        readBucketMetadata,
        probeOciBucket,
      }),
    ).resolves.toBe("verified");
    expect(readBucketMetadata).not.toHaveBeenCalled();
    expect(probeOciBucket).toHaveBeenCalledWith("health-private");
  });

  it("fails closed when OCI configuration is outside Riyadh", async () => {
    const probeOciBucket = vi.fn();

    await expect(
      checkObjectStorageReadiness({
        env: {
          ...productionEnv,
          OBJECT_STORAGE_PROVIDER: "oci",
          OCI_OBJECT_STORAGE_REGION: "me-dubai-1",
          OCI_OBJECT_STORAGE_ENDPOINT:
            "https://tenantns.compat.objectstorage.me-dubai-1.oraclecloud.com",
          OCI_OBJECT_STORAGE_ACCESS_KEY_ID: "test-access-key",
          OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
        },
        probeOciBucket,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageReadinessError);
    expect(probeOciBucket).not.toHaveBeenCalled();
  });

  it("fails closed when the OCI bucket cannot be reached", async () => {
    const probeOciBucket = vi
      .fn()
      .mockRejectedValue(new Error("bucket denied"));

    await expect(
      checkObjectStorageReadiness({
        env: {
          ...productionEnv,
          OBJECT_STORAGE_PROVIDER: "oci",
          OCI_OBJECT_STORAGE_REGION: "me-riyadh-1",
          OCI_OBJECT_STORAGE_ENDPOINT:
            "https://tenantns.compat.objectstorage.me-riyadh-1.oraclecloud.com",
          OCI_OBJECT_STORAGE_ACCESS_KEY_ID: "test-access-key",
          OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
        },
        probeOciBucket,
      }),
    ).rejects.toThrow("bucket denied");
  });

  it("verifies the single-host filesystem directory", async () => {
    const probeFilesystemStorage = vi.fn().mockResolvedValue(undefined);

    await expect(
      checkObjectStorageReadiness({
        env: {
          ...productionEnv,
          OBJECT_STORAGE_PROVIDER: "filesystem",
          LOCAL_OBJECT_STORAGE_DIR: absoluteFilesystemRoot,
          PUBLIC_APP_URL: "https://app.wathaiqihealth.com",
        },
        probeFilesystemStorage,
      }),
    ).resolves.toBe("verified");
    expect(probeFilesystemStorage).toHaveBeenCalledOnce();
  });

  it("fails closed before probing a relative filesystem directory", async () => {
    const probeFilesystemStorage = vi.fn();

    await expect(
      checkObjectStorageReadiness({
        env: {
          ...productionEnv,
          OBJECT_STORAGE_PROVIDER: "filesystem",
          LOCAL_OBJECT_STORAGE_DIR: "relative-objects",
          PUBLIC_APP_URL: "https://app.wathaiqihealth.com",
        },
        probeFilesystemStorage,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageReadinessError);
    expect(probeFilesystemStorage).not.toHaveBeenCalled();
  });
});
