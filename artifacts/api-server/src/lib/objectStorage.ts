import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import { File, Storage } from "@google-cloud/storage";

import {
  canAccessObject,
  getObjectAclPolicy,
  type ObjectAclPolicy,
  ObjectPermission,
  setObjectAclPolicy,
} from "./objectAcl";

export type ObjectStorageProvider = "gcs" | "oci";

export interface StoredObjectMetadata {
  contentType?: string;
  size?: number | string;
  metadata?: Record<string, string>;
}

/** Provider-neutral object handle used by ACL, OCR, and download code. */
export interface StoredObjectFile {
  readonly name: string;
  exists(): Promise<[boolean]>;
  getMetadata(): Promise<[StoredObjectMetadata]>;
  setMetadata(input: { metadata?: Record<string, string> }): Promise<unknown>;
  createReadStream(): Promise<Readable>;
  download(): Promise<[Buffer]>;
}

// Uses Google Application Default Credentials. On Cloud Run this is the
// attached service account, so no long-lived JSON key is stored or mounted.
export const objectStorageClient = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  ...(process.env.STORAGE_API_ENDPOINT
    ? { apiEndpoint: process.env.STORAGE_API_ENDPOINT }
    : {}),
});

export const GCS_UPLOAD_REQUIRED_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    "x-goog-if-generation-match": "0",
  });

export const OCI_UPLOAD_REQUIRED_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    "if-none-match": "*",
  });

// Kept for source compatibility with the default Google driver.
export const UPLOAD_REQUIRED_HEADERS = GCS_UPLOAD_REQUIRED_HEADERS;

const OCI_RIYADH_REGION = "me-riyadh-1";
const OCI_RIYADH_ENDPOINT =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.compat\.objectstorage\.me-riyadh-1\.(?:oraclecloud\.com|oci\.customer-oci\.com)$/;

let ociClient: S3Client | undefined;
let ociClientKey = "";

function normalizeStorageRoot(path: string): string {
  return `/${path.trim().replace(/^\/+|\/+$/g, "")}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export function getObjectStorageProvider(): ObjectStorageProvider {
  const provider = (process.env.OBJECT_STORAGE_PROVIDER || "gcs")
    .trim()
    .toLowerCase();
  if (provider !== "gcs" && provider !== "oci") {
    throw new Error("OBJECT_STORAGE_PROVIDER must be gcs or oci");
  }
  return provider;
}

function getValidatedOciEndpoint(): URL {
  const raw = requiredEnv("OCI_OBJECT_STORAGE_ENDPOINT");
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("OCI_OBJECT_STORAGE_ENDPOINT must be a valid URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !OCI_RIYADH_ENDPOINT.test(endpoint.hostname)
  ) {
    throw new Error(
      "OCI_OBJECT_STORAGE_ENDPOINT must be the exact HTTPS S3-compatible endpoint for me-riyadh-1",
    );
  }
  return endpoint;
}

function getOciClient(): S3Client {
  const endpoint = getValidatedOciEndpoint();
  const region = requiredEnv("OCI_OBJECT_STORAGE_REGION");
  if (region !== OCI_RIYADH_REGION) {
    throw new Error("OCI_OBJECT_STORAGE_REGION must be me-riyadh-1");
  }
  const accessKeyId = requiredEnv("OCI_OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY");
  const clientKey = `${endpoint.origin}|${region}|${accessKeyId}`;
  if (!ociClient || ociClientKey !== clientKey) {
    ociClient = new S3Client({
      endpoint: endpoint.origin,
      region,
      forcePathStyle: true,
      maxAttempts: 2,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId, secretAccessKey },
    });
    ociClientKey = clientKey;
  }
  return ociClient;
}

export function validateObjectStorageConfiguration(): void {
  if (getObjectStorageProvider() === "oci") {
    getOciClient();
    return;
  }

  const configuredEndpoint = process.env.STORAGE_API_ENDPOINT?.trim();
  if (!configuredEndpoint) return;
  let endpoint: URL;
  try {
    endpoint = new URL(configuredEndpoint);
  } catch {
    throw new Error("STORAGE_API_ENDPOINT must be a valid URL");
  }
  const approved =
    endpoint.protocol === "https:" &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.port &&
    !endpoint.search &&
    !endpoint.hash &&
    (endpoint.hostname === "storage.googleapis.com" ||
      /^storage\.[a-z0-9-]+\.rep\.googleapis\.com$/.test(endpoint.hostname));
  if (process.env.NODE_ENV === "production" && !approved) {
    throw new Error(
      "Production STORAGE_API_ENDPOINT must use an approved HTTPS Google Storage host",
    );
  }
}

export function getStorageConnectSources(): string[] {
  if (getObjectStorageProvider() === "oci") {
    return [getValidatedOciEndpoint().origin];
  }
  const sources = new Set(["https://storage.googleapis.com"]);
  const configuredEndpoint = process.env.STORAGE_API_ENDPOINT?.trim();
  if (configuredEndpoint) sources.add(new URL(configuredEndpoint).origin);
  return [...sources];
}

export function getUploadRequiredHeaders(): Record<string, string> {
  return {
    ...(getObjectStorageProvider() === "oci"
      ? OCI_UPLOAD_REQUIRED_HEADERS
      : GCS_UPLOAD_REQUIRED_HEADERS),
  };
}

export function validateStoragePathIsolation(): void {
  const privatePath = process.env.PRIVATE_OBJECT_DIR?.trim();
  const publicPaths =
    process.env.PUBLIC_OBJECT_SEARCH_PATHS?.split(",")
      .map((path) => path.trim())
      .filter(Boolean) ?? [];
  if (!privatePath || publicPaths.length === 0) return;

  const privateRoot = normalizeStorageRoot(privatePath);
  for (const rawPublicPath of publicPaths) {
    const publicRoot = normalizeStorageRoot(rawPublicPath);
    if (
      publicRoot === privateRoot ||
      publicRoot.startsWith(`${privateRoot}/`) ||
      privateRoot.startsWith(`${publicRoot}/`)
    ) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS must not overlap PRIVATE_OBJECT_DIR",
      );
    }
  }
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

class GcsStoredObjectFile implements StoredObjectFile {
  constructor(private readonly file: File) {}

  get name(): string {
    return this.file.name;
  }

  exists(): Promise<[boolean]> {
    return this.file.exists();
  }

  async getMetadata(): Promise<[StoredObjectMetadata]> {
    const [metadata] = await this.file.getMetadata();
    return [metadata as StoredObjectMetadata];
  }

  setMetadata(input: { metadata?: Record<string, string> }): Promise<unknown> {
    return this.file.setMetadata(input);
  }

  async createReadStream(): Promise<Readable> {
    return this.file.createReadStream();
  }

  download(): Promise<[Buffer]> {
    return this.file.download();
  }
}

function isNotFound(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.$metadata?.httpStatusCode === 404 ||
    candidate?.name === "NotFound" ||
    candidate?.name === "NoSuchKey" ||
    candidate?.Code === "NoSuchKey"
  );
}

class OciStoredObjectFile implements StoredObjectFile {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
    private readonly objectName: string,
  ) {}

  get name(): string {
    return this.objectName;
  }

  async exists(): Promise<[boolean]> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: this.objectName,
        }),
      );
      return [true];
    } catch (error) {
      if (isNotFound(error)) return [false];
      throw error;
    }
  }

  async getMetadata(): Promise<[StoredObjectMetadata]> {
    try {
      const metadata = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: this.objectName,
        }),
      );
      return [
        {
          contentType: metadata.ContentType,
          size: metadata.ContentLength,
          metadata: metadata.Metadata,
        },
      ];
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError();
      throw error;
    }
  }

  async setMetadata(input: {
    metadata?: Record<string, string>;
  }): Promise<void> {
    // OCI's compatibility API does not expose CopyObject. Credential files are
    // capped at 8 MB, so preserve the current bytes before replacing metadata.
    const current = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: this.objectName }),
    );
    if (!current.Body) throw new ObjectNotFoundError();
    const bytes = Buffer.from(await current.Body.transformToByteArray());
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: this.objectName,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: current.ContentType,
        CacheControl: current.CacheControl,
        Metadata: Object.fromEntries(
          Object.entries(input.metadata ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      }),
    );
  }

  async createReadStream(): Promise<Readable> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: this.objectName }),
      );
      if (!response.Body) throw new ObjectNotFoundError();
      if (response.Body instanceof Readable) return response.Body;
      return Readable.from(response.Body as AsyncIterable<Uint8Array>);
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError();
      throw error;
    }
  }

  async download(): Promise<[Buffer]> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: this.objectName }),
      );
      if (!response.Body) throw new ObjectNotFoundError();
      return [Buffer.from(await response.Body.transformToByteArray())];
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError();
      throw error;
    }
  }
}

function getStoredObject(fullPath: string): StoredObjectFile {
  const { bucketName, objectName } = parseObjectPath(fullPath);
  if (getObjectStorageProvider() === "oci") {
    return new OciStoredObjectFile(getOciClient(), bucketName, objectName);
  }
  return new GcsStoredObjectFile(
    objectStorageClient.bucket(bucketName).file(objectName),
  );
}

export class ObjectStorageService {
  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS must be set to comma-separated private-bucket paths",
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error("PRIVATE_OBJECT_DIR must be set to /bucket-name/private");
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<StoredObjectFile | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const file = getStoredObject(`${searchPath}/${filePath}`);
      const [exists] = await file.exists();
      if (exists) return file;
    }
    return null;
  }

  async downloadObject(
    file: StoredObjectFile,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";
    const nodeStream = await file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Cache-Control": isPublic
        ? `public, max-age=${cacheTtlSec}`
        : "private, no-store, max-age=0",
    };
    if (metadata.size) headers["Content-Length"] = String(metadata.size);
    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(contentType: string): Promise<{
    uploadURL: string;
    requiredHeaders: Record<string, string>;
  }> {
    const fullPath = `${this.getPrivateObjectDir()}/uploads/${randomUUID()}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    if (getObjectStorageProvider() === "oci") {
      const uploadURL = await getS3SignedUrl(
        getOciClient(),
        new PutObjectCommand({
          Bucket: bucketName,
          Key: objectName,
          ContentType: contentType,
          IfNoneMatch: "*",
        }),
        { expiresIn: 15 * 60 },
      );
      return { uploadURL, requiredHeaders: getUploadRequiredHeaders() };
    }

    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [uploadURL] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
      extensionHeaders: GCS_UPLOAD_REQUIRED_HEADERS,
    });
    return { uploadURL, requiredHeaders: getUploadRequiredHeaders() };
  }

  async getObjectEntityFile(objectPath: string): Promise<StoredObjectFile> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const entityId = objectPath.slice("/objects/".length);
    if (!entityId || entityId.startsWith("/") || entityId.includes("..")) {
      throw new ObjectNotFoundError();
    }
    const entityDir = `${this.getPrivateObjectDir().replace(/\/+$/g, "")}/`;
    const objectFile = getStoredObject(`${entityDir}${entityId}`);
    const [exists] = await objectFile.exists();
    if (!exists) throw new ObjectNotFoundError();
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    let url: URL;
    try {
      url = new URL(rawPath);
    } catch {
      return rawPath;
    }
    const isGoogleStorageHost =
      url.protocol === "https:" &&
      (url.hostname === "storage.googleapis.com" ||
        url.hostname.endsWith(".storage.googleapis.com") ||
        /^storage\.[a-z0-9-]+\.rep\.googleapis\.com$/.test(url.hostname));
    let isConfiguredOciHost = false;
    if (process.env.OCI_OBJECT_STORAGE_ENDPOINT) {
      try {
        isConfiguredOciHost = url.origin === getValidatedOciEndpoint().origin;
      } catch {
        isConfiguredOciHost = false;
      }
    }
    if (!isGoogleStorageHost && !isConfiguredOciHost) return rawPath;

    const objectEntityDir = `${this.getPrivateObjectDir().replace(/\/+$/g, "")}/`;
    if (!url.pathname.startsWith(objectEntityDir)) return url.pathname;
    return `/objects/${url.pathname.slice(objectEntityDir.length)}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) return normalizedPath;
    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: StoredObjectFile;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const pathParts = normalized.split("/");
  if (pathParts.length < 3 || !pathParts[1] || !pathParts.slice(2).join("/")) {
    throw new Error("Invalid path: must contain a bucket and object name");
  }
  return {
    bucketName: pathParts[1],
    objectName: pathParts.slice(2).join("/"),
  };
}
