import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FILESYSTEM_UPLOAD_REQUIRED_HEADERS,
  getObjectStorageProvider,
  getStorageConnectSources,
  getUploadRequiredHeaders,
  ObjectNotFoundError,
  ObjectStorageService,
  OCI_UPLOAD_REQUIRED_HEADERS,
  type StoredObjectFile,
  UPLOAD_REQUIRED_HEADERS,
  validateObjectStorageConfiguration,
} from "./objectStorage";

const originalPrivateDir = process.env.PRIVATE_OBJECT_DIR;
const originalProvider = process.env.OBJECT_STORAGE_PROVIDER;
const originalOciEndpoint = process.env.OCI_OBJECT_STORAGE_ENDPOINT;
const originalOciRegion = process.env.OCI_OBJECT_STORAGE_REGION;
const originalOciAccessKey = process.env.OCI_OBJECT_STORAGE_ACCESS_KEY_ID;
const originalOciSecret = process.env.OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY;
const originalLocalStorageDir = process.env.LOCAL_OBJECT_STORAGE_DIR;
const originalPublicAppUrl = process.env.PUBLIC_APP_URL;
const originalNodeEnv = process.env.NODE_ENV;
let localTestDir: string | undefined;

beforeEach(() => {
  process.env.PRIVATE_OBJECT_DIR = "/healthdocs-private/private";
  delete process.env.OBJECT_STORAGE_PROVIDER;
  delete process.env.OCI_OBJECT_STORAGE_ENDPOINT;
  delete process.env.OCI_OBJECT_STORAGE_REGION;
  delete process.env.OCI_OBJECT_STORAGE_ACCESS_KEY_ID;
  delete process.env.OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  delete process.env.LOCAL_OBJECT_STORAGE_DIR;
  delete process.env.PUBLIC_APP_URL;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  if (localTestDir) {
    await rm(localTestDir, { recursive: true, force: true });
    localTestDir = undefined;
  }
  if (originalPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = originalPrivateDir;
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
  if (originalLocalStorageDir === undefined)
    delete process.env.LOCAL_OBJECT_STORAGE_DIR;
  else process.env.LOCAL_OBJECT_STORAGE_DIR = originalLocalStorageDir;
  if (originalPublicAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = originalPublicAppUrl;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("Google Cloud Storage object paths", () => {
  const service = new ObjectStorageService();

  beforeEach(() => {
    process.env.OBJECT_STORAGE_PROVIDER = "gcs";
  });

  it("requires an exact non-traversing private object directory", () => {
    expect(service.getPrivateObjectDir()).toBe("/healthdocs-private/private");

    for (const invalid of [
      "/../private",
      "/healthdocs-private/../private",
      "/healthdocs-private/%2e%2e/private",
      "/healthdocs-private\\..\\private",
      "/healthdocs-private//private",
      "/healthdocs-private/private/",
      " /healthdocs-private/private",
    ]) {
      process.env.PRIVATE_OBJECT_DIR = invalid;
      expect(() => service.getPrivateObjectDir(), invalid).toThrow(
        /\/bucket-name\/private/,
      );
    }
  });

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
      delete: async () => undefined,
      name: "private/uploads/1",
    } as unknown as StoredObjectFile;

    const response = await service.downloadObject(file);

    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
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

  it("requires an explicit provider and keeps OCI opt-in", () => {
    expect(() => getObjectStorageProvider()).toThrow(
      "OBJECT_STORAGE_PROVIDER must be set",
    );
    process.env.OBJECT_STORAGE_PROVIDER = "gcs";
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

describe("single-host filesystem object storage configuration", () => {
  const configureFilesystem = async () => {
    localTestDir = await mkdtemp(path.join(tmpdir(), "healthdocs-storage-"));
    process.env.OBJECT_STORAGE_PROVIDER = "filesystem";
    process.env.LOCAL_OBJECT_STORAGE_DIR = localTestDir;
    process.env.PUBLIC_APP_URL = "https://app.wathaiqihealth.com";
  };

  it("uses the explicit filesystem provider", async () => {
    await configureFilesystem();
    expect(getObjectStorageProvider()).toBe("filesystem");
    expect(() => validateObjectStorageConfiguration()).not.toThrow();
  });

  it("returns a relative same-origin authenticated upload URL", async () => {
    await configureFilesystem();
    delete process.env.PUBLIC_APP_URL;
    const service = new ObjectStorageService();
    const granted = await service.getObjectEntityUploadURL("application/pdf");
    expect(granted.uploadURL).toMatch(
      /^\/api\/storage\/uploads\/local\/[0-9a-f-]{36}$/,
    );
    expect(service.normalizeObjectEntityPath(granted.uploadURL)).toMatch(
      /^\/objects\/uploads\/[0-9a-f-]{36}$/,
    );
    expect(granted.requiredHeaders).toEqual(FILESYSTEM_UPLOAD_REQUIRED_HEADERS);
    expect(getStorageConnectSources()).toEqual([]);
  });

  it("normalizes only an exact relative local upload URL", async () => {
    await configureFilesystem();
    const service = new ObjectStorageService();
    const uploadId = "f3fddc5a-9315-4b7b-8e7c-8ac98bc9f6c5";

    expect(
      service.normalizeObjectEntityPath(
        `/api/storage/uploads/local/${uploadId}`,
      ),
    ).toBe(`/objects/uploads/${uploadId}`);
    expect(
      service.normalizeObjectEntityPath(
        `/api/storage/uploads/local/${uploadId}?redirect=https://attacker.example`,
      ),
    ).toContain("?redirect=");
  });

  it("writes private bytes and metadata outside the workspace", async () => {
    await configureFilesystem();
    const service = new ObjectStorageService();
    const granted = await service.getObjectEntityUploadURL("application/pdf");
    const objectPath = service.normalizeObjectEntityPath(granted.uploadURL);
    await service.writeFilesystemObject(
      objectPath,
      Buffer.from("document"),
      "application/pdf",
    );
    const file = await service.getObjectEntityFile(objectPath);
    await expect(file.download()).resolves.toEqual([Buffer.from("document")]);
    await expect(file.getMetadata()).resolves.toEqual([
      expect.objectContaining({ contentType: "application/pdf", size: 8 }),
    ]);

    await service.deleteObject(file);
    await expect(
      service.getObjectEntityFile(objectPath),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("rejects relative storage paths", async () => {
    await configureFilesystem();
    process.env.LOCAL_OBJECT_STORAGE_DIR = "relative-storage";
    expect(() => validateObjectStorageConfiguration()).toThrow(/absolute path/);
  });
});
