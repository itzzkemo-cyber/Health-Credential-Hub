import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  getObjectStorageProvider,
  getStorageConnectSources,
  getUploadRequiredHeaders,
  ObjectStorageService,
  OCI_UPLOAD_REQUIRED_HEADERS,
  type StoredObjectFile,
  UPLOAD_REQUIRED_HEADERS,
  validateObjectStorageConfiguration,
  validateStoragePathIsolation,
} from "./objectStorage";

const originalPrivateDir = process.env.PRIVATE_OBJECT_DIR;
const originalPublicPaths = process.env.PUBLIC_OBJECT_SEARCH_PATHS;
const originalProvider = process.env.OBJECT_STORAGE_PROVIDER;
const originalOciEndpoint = process.env.OCI_OBJECT_STORAGE_ENDPOINT;
const originalOciRegion = process.env.OCI_OBJECT_STORAGE_REGION;
const originalOciAccessKey = process.env.OCI_OBJECT_STORAGE_ACCESS_KEY_ID;
const originalOciSecret = process.env.OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY;

beforeEach(() => {
  process.env.PRIVATE_OBJECT_DIR = "/healthdocs-private/private";
  delete process.env.PUBLIC_OBJECT_SEARCH_PATHS;
  delete process.env.OBJECT_STORAGE_PROVIDER;
  delete process.env.OCI_OBJECT_STORAGE_ENDPOINT;
  delete process.env.OCI_OBJECT_STORAGE_REGION;
  delete process.env.OCI_OBJECT_STORAGE_ACCESS_KEY_ID;
  delete process.env.OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY;
});

afterEach(() => {
  if (originalPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = originalPrivateDir;
  if (originalPublicPaths === undefined)
    delete process.env.PUBLIC_OBJECT_SEARCH_PATHS;
  else process.env.PUBLIC_OBJECT_SEARCH_PATHS = originalPublicPaths;
  if (originalProvider === undefined)
    delete process.env.OBJECT_STORAGE_PROVIDER;
  else process.env.OBJECT_STORAGE_PROVIDER = originalProvider;
  if (originalOciEndpoint === undefined)
    delete process.env.OCI_OBJECT_STORAGE_ENDPOINT;
  else process.env.OCI_OBJECT_STORAGE_ENDPOINT = originalOciEndpoint;
  if (originalOciRegion === undefined)
    delete process.env.OCI_OBJECT_STORAGE_REGION;
  else process.env.OCI_OBJECT_STORAGE_REGION = originalOciRegion;
  if (originalOciAccessKey === undefined)
    delete process.env.OCI_OBJECT_STORAGE_ACCESS_KEY_ID;
  else process.env.OCI_OBJECT_STORAGE_ACCESS_KEY_ID = originalOciAccessKey;
  if (originalOciSecret === undefined)
    delete process.env.OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  else process.env.OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY = originalOciSecret;
});

describe("Google Cloud Storage object paths", () => {
  const service = new ObjectStorageService();

  it("normalizes a global signed upload URL", () => {
    expect(
      service.normalizeObjectEntityPath(
        "https://storage.googleapis.com/healthdocs-private/private/uploads/123?X-Goog-Signature=test",
      ),
    ).toBe("/objects/uploads/123");
  });

  it("normalizes the Dammam regional endpoint", () => {
    expect(
      service.normalizeObjectEntityPath(
        "https://storage.me-central2.rep.googleapis.com/healthdocs-private/private/uploads/456",
      ),
    ).toBe("/objects/uploads/456");
  });

  it("does not trust a lookalike external host", () => {
    const url =
      "https://storage.googleapis.com.attacker.example/healthdocs-private/private/uploads/789";
    expect(service.normalizeObjectEntityPath(url)).toBe(url);
  });

  it("requires create-only semantics for every signed upload", () => {
    expect(UPLOAD_REQUIRED_HEADERS).toEqual({
      "x-goog-if-generation-match": "0",
    });
  });

  it("prevents browser caching for private credential documents", async () => {
    const metadata = {
      contentType: "application/pdf",
      size: "8",
      metadata: {
        "custom:aclPolicy": JSON.stringify({
          owner: "7",
          visibility: "private",
        }),
      },
    };
    const file = {
      getMetadata: async () => [metadata],
      createReadStream: () => Readable.from(Buffer.from("document")),
      exists: async () => [true],
      setMetadata: async () => undefined,
      download: async () => [Buffer.from("document")],
      name: "private/uploads/1",
    } as unknown as StoredObjectFile;

    const response = await service.downloadObject(file);

    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
  });

  it("accepts sibling public and private storage roots", () => {
    process.env.PUBLIC_OBJECT_SEARCH_PATHS = "/healthdocs-private/public";
    expect(() => validateStoragePathIsolation()).not.toThrow();
  });

  it("rejects a public root that contains the private document path", () => {
    process.env.PUBLIC_OBJECT_SEARCH_PATHS = "/healthdocs-private";
    expect(() => validateStoragePathIsolation()).toThrow(/must not overlap/);
  });
});

describe("OCI Riyadh object storage configuration", () => {
  const configureOci = () => {
    process.env.OBJECT_STORAGE_PROVIDER = "oci";
    process.env.OCI_OBJECT_STORAGE_ENDPOINT =
      "https://tenantns.compat.objectstorage.me-riyadh-1.oraclecloud.com";
    process.env.OCI_OBJECT_STORAGE_REGION = "me-riyadh-1";
    process.env.OCI_OBJECT_STORAGE_ACCESS_KEY_ID = "test-access-key";
    process.env.OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY = "test-secret-key";
  };

  it("is opt-in and preserves GCS as the default", () => {
    expect(getObjectStorageProvider()).toBe("gcs");
    configureOci();
    expect(getObjectStorageProvider()).toBe("oci");
  });

  it("normalizes an exact OCI path-style presigned upload URL", () => {
    configureOci();
    const service = new ObjectStorageService();
    expect(
      service.normalizeObjectEntityPath(
        "https://tenantns.compat.objectstorage.me-riyadh-1.oraclecloud.com/healthdocs-private/private/uploads/789?X-Amz-Signature=test",
      ),
    ).toBe("/objects/uploads/789");
  });

  it("requires create-only conditional writes", () => {
    configureOci();
    expect(getUploadRequiredHeaders()).toEqual(OCI_UPLOAD_REQUIRED_HEADERS);
  });

  it("presigns a path-style upload without an empty-body checksum", async () => {
    configureOci();
    const result = await new ObjectStorageService().getObjectEntityUploadURL(
      "application/pdf",
    );
    const url = new URL(result.uploadURL);
    expect(url.origin).toBe(
      "https://tenantns.compat.objectstorage.me-riyadh-1.oraclecloud.com",
    );
    expect(url.pathname).toMatch(
      /^\/healthdocs-private\/private\/uploads\/[0-9a-f-]+$/,
    );
    expect(url.searchParams.has("x-amz-checksum-crc32")).toBe(false);
  });

  it("exposes only the configured OCI origin to browser CSP", () => {
    configureOci();
    expect(getStorageConnectSources()).toEqual([
      "https://tenantns.compat.objectstorage.me-riyadh-1.oraclecloud.com",
    ]);
  });

  it("rejects non-Riyadh and lookalike endpoints", () => {
    configureOci();
    process.env.OCI_OBJECT_STORAGE_ENDPOINT =
      "https://tenantns.compat.objectstorage.me-jeddah-1.oraclecloud.com";
    expect(() => validateObjectStorageConfiguration()).toThrow(/me-riyadh-1/);
    process.env.OCI_OBJECT_STORAGE_ENDPOINT =
      "https://tenantns.compat.objectstorage.me-riyadh-1.oraclecloud.com.attacker.example";
    expect(() => validateObjectStorageConfiguration()).toThrow(/me-riyadh-1/);
  });
});
