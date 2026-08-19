import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { File } from "@google-cloud/storage";
import {
  ObjectStorageService,
  UPLOAD_REQUIRED_HEADERS,
  validateStoragePathIsolation,
} from "./objectStorage";

const originalPrivateDir = process.env.PRIVATE_OBJECT_DIR;
const originalPublicPaths = process.env.PUBLIC_OBJECT_SEARCH_PATHS;

beforeEach(() => {
  process.env.PRIVATE_OBJECT_DIR = "/healthdocs-private/private";
  delete process.env.PUBLIC_OBJECT_SEARCH_PATHS;
});

afterEach(() => {
  if (originalPrivateDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = originalPrivateDir;
  if (originalPublicPaths === undefined)
    delete process.env.PUBLIC_OBJECT_SEARCH_PATHS;
  else process.env.PUBLIC_OBJECT_SEARCH_PATHS = originalPublicPaths;
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
    } as unknown as File;

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
