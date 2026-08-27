import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
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
import { getPublicAppUrl } from "./publicUrl";

export type ObjectStorageProvider = "gcs" | "oci" | "s3" | "filesystem";

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
  delete(): Promise<void>;
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

export const S3_UPLOAD_REQUIRED_HEADERS = OCI_UPLOAD_REQUIRED_HEADERS;
export const FILESYSTEM_UPLOAD_REQUIRED_HEADERS = OCI_UPLOAD_REQUIRED_HEADERS;

// Kept for source compatibility with the default Google driver.
export const UPLOAD_REQUIRED_HEADERS = GCS_UPLOAD_REQUIRED_HEADERS;

const OCI_RIYADH_REGION = "me-riyadh-1";
const OCI_RIYADH_ENDPOINT =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.compat\.objectstorage\.me-riyadh-1\.(?:oraclecloud\.com|oci\.customer-oci\.com)$/;

let ociClient: S3Client | undefined;
let ociClientKey = "";
let s3Client: S3Client | undefined;
let s3ClientKey = "";

function requiredEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export function getObjectStorageProvider(): ObjectStorageProvider {
  const provider = requiredEnv("OBJECT_STORAGE_PROVIDER").toLowerCase();
  if (
    provider !== "gcs" &&
    provider !== "oci" &&
    provider !== "s3" &&
    provider !== "filesystem"
  ) {
    throw new Error(
      "OBJECT_STORAGE_PROVIDER must be gcs, oci, s3, or filesystem",
    );
  }
  return provider;
}

function getValidatedS3Endpoint(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = requiredEnv("S3_OBJECT_STORAGE_ENDPOINT", env);
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("S3_OBJECT_STORAGE_ENDPOINT must be a valid URL");
  }

  const hostname = endpoint.hostname.toLowerCase();
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, "");
  const isSupabaseProjectEndpoint =
    /^[a-z0-9]{20}\.storage\.supabase\.co$/.test(hostname) &&
    endpoint.pathname === "/storage/v1/s3";
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(unbracketedHostname) !== 0 ||
    /[\\\u0000-\u001f\u007f]/.test(endpoint.pathname) ||
    !isSupabaseProjectEndpoint
  ) {
    throw new Error(
      "S3_OBJECT_STORAGE_ENDPOINT must be the exact HTTPS endpoint for one Supabase project at /storage/v1/s3",
    );
  }
  return endpoint;
}

export function validateS3ObjectStorageEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  getValidatedS3Endpoint(env);
  requiredEnv("S3_OBJECT_STORAGE_REGION", env);
  requiredEnv("S3_OBJECT_STORAGE_ACCESS_KEY_ID", env);
  requiredEnv("S3_OBJECT_STORAGE_SECRET_ACCESS_KEY", env);
}

function getValidatedOciEndpoint(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = requiredEnv("OCI_OBJECT_STORAGE_ENDPOINT", env);
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

export function validateOciObjectStorageEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  getValidatedOciEndpoint(env);
  const region = requiredEnv("OCI_OBJECT_STORAGE_REGION", env);
  if (region !== OCI_RIYADH_REGION) {
    throw new Error("OCI_OBJECT_STORAGE_REGION must be me-riyadh-1");
  }
  requiredEnv("OCI_OBJECT_STORAGE_ACCESS_KEY_ID", env);
  requiredEnv("OCI_OBJECT_STORAGE_SECRET_ACCESS_KEY", env);
}

export function getFilesystemObjectStorageRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = requiredEnv("LOCAL_OBJECT_STORAGE_DIR", env);
  if (!path.isAbsolute(configured)) {
    throw new Error("LOCAL_OBJECT_STORAGE_DIR must be an absolute path");
  }
  const resolved = path.resolve(configured);
  if (env.NODE_ENV === "production") {
    const normalized = resolved.toLowerCase();
    const workspace = path.resolve(process.cwd()).toLowerCase();
    const temporary = path.resolve(tmpdir()).toLowerCase();
    if (
      normalized === workspace ||
      normalized.startsWith(`${workspace}${path.sep}`) ||
      normalized === temporary ||
      normalized.startsWith(`${temporary}${path.sep}`)
    ) {
      throw new Error(
        "Production LOCAL_OBJECT_STORAGE_DIR must be outside the workspace and temporary directory",
      );
    }
  }
  return resolved;
}

export function validateFilesystemObjectStorageEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  getFilesystemObjectStorageRoot(env);
}

export async function probeFilesystemObjectStorage(): Promise<void> {
  validateFilesystemObjectStorageEnvironment();
  const root = getFilesystemObjectStorageRoot();
  const probeDir = path.join(root, ".readiness");
  const probePath = path.join(probeDir, `${randomUUID()}.probe`);
  const expected = Buffer.from(randomUUID(), "utf8");
  await mkdir(probeDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(probePath, expected, { flag: "wx", mode: 0o600 });
    const observed = await readFile(probePath);
    if (!observed.equals(expected)) {
      throw new Error("Filesystem object storage readiness probe mismatched");
    }
  } finally {
    await rm(probePath, { force: true });
  }
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

function getS3Client(): S3Client {
  const endpoint = getValidatedS3Endpoint();
  const region = requiredEnv("S3_OBJECT_STORAGE_REGION");
  const accessKeyId = requiredEnv("S3_OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("S3_OBJECT_STORAGE_SECRET_ACCESS_KEY");
  // Deliberately exclude the secret from the cache key so it can never appear
  // in diagnostics or an accidentally stringified client identifier.
  const clientKey = `${endpoint.href}|${region}|${accessKeyId}`;
  if (!s3Client || s3ClientKey !== clientKey) {
    s3Client = new S3Client({
      endpoint: endpoint.href,
      region,
      forcePathStyle: true,
      maxAttempts: 2,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId, secretAccessKey },
    });
    s3ClientKey = clientKey;
  }
  return s3Client;
}

/** Read-only reachability probe for the configured private OCI bucket. */
export async function headOciBucket(bucketName: string): Promise<void> {
  await getOciClient().send(new HeadBucketCommand({ Bucket: bucketName }));
}

/** Read-only reachability probe for a configured private S3 bucket. */
export async function headS3Bucket(bucketName: string): Promise<void> {
  await getS3Client().send(new HeadBucketCommand({ Bucket: bucketName }));
}

export function validateObjectStorageConfiguration(): void {
  const provider = getObjectStorageProvider();
  if (provider === "oci") {
    getOciClient();
    return;
  }
  if (provider === "s3") {
    getS3Client();
    return;
  }
  if (provider === "filesystem") {
    validateFilesystemObjectStorageEnvironment();
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
  const provider = getObjectStorageProvider();
  if (provider === "oci") {
    return [getValidatedOciEndpoint().origin];
  }
  if (provider === "s3" || provider === "filesystem") {
    // These providers use a same-origin, server-mediated upload. Their private
    // storage endpoints must never be reachable from browser JavaScript.
    return [];
  }
  const sources = new Set(["https://storage.googleapis.com"]);
  const configuredEndpoint = process.env.STORAGE_API_ENDPOINT?.trim();
  if (configuredEndpoint) sources.add(new URL(configuredEndpoint).origin);
  return [...sources];
}

export function getUploadRequiredHeaders(): Record<string, string> {
  const provider = getObjectStorageProvider();
  return {
    ...(provider === "gcs"
      ? GCS_UPLOAD_REQUIRED_HEADERS
      : OCI_UPLOAD_REQUIRED_HEADERS),
  };
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectAlreadyExistsError extends Error {
  constructor() {
    super("Object already exists");
    this.name = "ObjectAlreadyExistsError";
    Object.setPrototypeOf(this, ObjectAlreadyExistsError.prototype);
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

  async delete(): Promise<void> {
    try {
      await this.file.delete();
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError();
      throw error;
    }
  }
}

interface FilesystemMetadataFile {
  contentType: string;
  metadata?: Record<string, string>;
}

function resolveFilesystemObjectPath(
  bucketName: string,
  objectName: string,
): string {
  const bucketRoot = path.resolve(getFilesystemObjectStorageRoot(), bucketName);
  const objectPath = path.resolve(bucketRoot, ...objectName.split("/"));
  if (!objectPath.startsWith(`${bucketRoot}${path.sep}`)) {
    throw new Error("Object path escapes the configured filesystem bucket");
  }
  return objectPath;
}

class FilesystemStoredObjectFile implements StoredObjectFile {
  private readonly filePath: string;
  private readonly metadataPath: string;

  constructor(
    bucketName: string,
    private readonly objectName: string,
  ) {
    this.filePath = resolveFilesystemObjectPath(bucketName, objectName);
    this.metadataPath = `${this.filePath}.metadata.json`;
  }

  get name(): string {
    return this.objectName;
  }

  async exists(): Promise<[boolean]> {
    try {
      await stat(this.filePath);
      return [true];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [false];
      throw error;
    }
  }

  private async readMetadataFile(): Promise<FilesystemMetadataFile> {
    try {
      const parsed = JSON.parse(
        await readFile(this.metadataPath, "utf8"),
      ) as FilesystemMetadataFile;
      if (!parsed.contentType || typeof parsed.contentType !== "string") {
        throw new Error("Stored filesystem metadata is invalid");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
  }

  async getMetadata(): Promise<[StoredObjectMetadata]> {
    try {
      const [fileStat, metadata] = await Promise.all([
        stat(this.filePath),
        this.readMetadataFile(),
      ]);
      return [
        {
          contentType: metadata.contentType,
          size: fileStat.size,
          metadata: metadata.metadata,
        },
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
  }

  async setMetadata(input: {
    metadata?: Record<string, string>;
  }): Promise<void> {
    const current = await this.readMetadataFile();
    await this.writeMetadata({
      contentType: current.contentType,
      metadata: Object.fromEntries(
        Object.entries(input.metadata ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    });
  }

  async write(
    bytes: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, bytes, { flag: "wx", mode: 0o600 });
    try {
      await this.writeMetadata({ contentType, metadata });
    } catch (error) {
      await rm(this.filePath, { force: true });
      throw error;
    }
  }

  private async writeMetadata(metadata: FilesystemMetadataFile): Promise<void> {
    const temporaryPath = `${this.metadataPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(metadata), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rm(this.metadataPath, { force: true });
      await rename(temporaryPath, this.metadataPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async createReadStream(): Promise<Readable> {
    const [exists] = await this.exists();
    if (!exists) throw new ObjectNotFoundError();
    return createReadStream(this.filePath);
  }

  async download(): Promise<[Buffer]> {
    try {
      return [await readFile(this.filePath)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
  }

  async delete(): Promise<void> {
    try {
      await rm(this.filePath);
      await rm(this.metadataPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: number;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.code === 404 ||
    candidate?.$metadata?.httpStatusCode === 404 ||
    candidate?.name === "NotFound" ||
    candidate?.name === "NoSuchKey" ||
    candidate?.Code === "NoSuchKey"
  );
}

function isCreateConflict(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: number | string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.code === 409 ||
    candidate?.code === 412 ||
    candidate?.$metadata?.httpStatusCode === 409 ||
    candidate?.$metadata?.httpStatusCode === 412 ||
    candidate?.name === "PreconditionFailed" ||
    candidate?.name === "ConditionalRequestConflict" ||
    candidate?.Code === "PreconditionFailed" ||
    candidate?.Code === "ConditionalRequestConflict"
  );
}

class S3StoredObjectFile implements StoredObjectFile {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
    private readonly objectName: string,
    private readonly useConditionalMetadataCopy: boolean,
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
    const current = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: this.objectName }),
    );
    if (!current.Body) throw new ObjectNotFoundError();
    const bytes = Buffer.from(await current.Body.transformToByteArray());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const suppliedSha256 = input.metadata?.["content-sha256"];
    if (suppliedSha256 && suppliedSha256 !== sha256) {
      throw new Error("Stored object integrity hash mismatch");
    }
    const metadata = {
      ...Object.fromEntries(
        Object.entries(input.metadata ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      "content-sha256": sha256,
    };

    if (this.useConditionalMetadataCopy) {
      if (!current.ETag) {
        throw new Error("Stored object version could not be verified");
      }
      const encodedCopySource = `${encodeURIComponent(this.bucketName)}/${this.objectName
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`;
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucketName,
          Key: this.objectName,
          CopySource: encodedCopySource,
          CopySourceIfMatch: current.ETag,
          MetadataDirective: "REPLACE",
          ContentType: current.ContentType,
          CacheControl: current.CacheControl,
          Metadata: metadata,
        }),
      );
      const verified = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: this.objectName }),
      );
      if (!verified.Body) throw new ObjectNotFoundError();
      const verifiedBytes = Buffer.from(
        await verified.Body.transformToByteArray(),
      );
      if (createHash("sha256").update(verifiedBytes).digest("hex") !== sha256) {
        throw new Error("Stored object changed during metadata update");
      }
      return;
    }

    // OCI compatibility retains the bounded read-and-replace path. The active
    // Supabase release uses the conditional same-object copy above.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: this.objectName,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: current.ContentType,
        CacheControl: current.CacheControl,
        Metadata: metadata,
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

  async delete(): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: this.objectName,
        }),
      );
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError();
      throw error;
    }
  }
}

function getStoredObject(
  fullPath: string,
  genericS3ClientFactory: () => S3Client = getS3Client,
): StoredObjectFile {
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const provider = getObjectStorageProvider();
  if (provider === "oci") {
    return new S3StoredObjectFile(
      getOciClient(),
      bucketName,
      objectName,
      false,
    );
  }
  if (provider === "s3") {
    return new S3StoredObjectFile(
      genericS3ClientFactory(),
      bucketName,
      objectName,
      true,
    );
  }
  if (provider === "filesystem") {
    return new FilesystemStoredObjectFile(bucketName, objectName);
  }
  return new GcsStoredObjectFile(
    objectStorageClient.bucket(bucketName).file(objectName),
  );
}

export class ObjectStorageService {
  constructor(
    private readonly genericS3ClientFactory: () => S3Client = getS3Client,
  ) {}

  getPrivateObjectDir(): string {
    const configured = process.env.PRIVATE_OBJECT_DIR ?? "";
    const parts = configured.split("/");
    if (
      !configured ||
      configured !== configured.trim() ||
      parts.length !== 3 ||
      parts[0] !== "" ||
      !parts[1] ||
      parts[1] === "." ||
      parts[1] === ".." ||
      parts[2] !== "private" ||
      /[\u0000-\u001f\u007f\\%?#]/.test(configured) ||
      path.posix.normalize(configured) !== configured
    ) {
      throw new Error("PRIVATE_OBJECT_DIR must be set to /bucket-name/private");
    }
    return configured;
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

  async deleteObject(file: StoredObjectFile): Promise<void> {
    await file.delete();
  }

  async getObjectEntityUploadURL(contentType: string): Promise<{
    uploadURL: string;
    requiredHeaders: Record<string, string>;
  }> {
    const uploadId = randomUUID();
    const fullPath = `${this.getPrivateObjectDir()}/uploads/${uploadId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const provider = getObjectStorageProvider();
    if (provider === "oci") {
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
    if (provider === "s3" || provider === "filesystem") {
      return {
        // A relative URL deliberately follows the browser's current origin.
        // The generic S3 profile is intentionally server-mediated: storage
        // credentials and its private endpoint never reach the browser, and
        // the API can fail closed when malware scanning is unavailable.
        uploadURL: `/api/storage/uploads/local/${uploadId}`,
        requiredHeaders: getUploadRequiredHeaders(),
      };
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

  async writeFilesystemObject(
    objectPath: string,
    bytes: Buffer,
    contentType: string,
    expectedSha256?: string,
  ): Promise<void> {
    if (getObjectStorageProvider() !== "filesystem") {
      throw new Error("Filesystem object uploads are not enabled");
    }
    if (!/^\/objects\/uploads\/[0-9a-f-]{36}$/.test(objectPath)) {
      throw new Error("Invalid filesystem upload path");
    }
    const entityId = objectPath.slice("/objects/".length);
    const entityDir = `${this.getPrivateObjectDir().replace(/\/+$/g, "")}/`;
    const { bucketName, objectName } = parseObjectPath(
      `${entityDir}${entityId}`,
    );
    await new FilesystemStoredObjectFile(bucketName, objectName).write(
      bytes,
      contentType,
      expectedSha256 ? { "content-sha256": expectedSha256 } : undefined,
    );
  }

  async writeServerMediatedObject(
    objectPath: string,
    bytes: Buffer,
    contentType: string,
    expectedSha256: string,
  ): Promise<void> {
    const provider = getObjectStorageProvider();
    if (!/^\/objects\/uploads\/[0-9a-f-]{36}$/.test(objectPath)) {
      throw new Error("Invalid server-mediated upload path");
    }
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error("Invalid server-mediated upload integrity hash");
    }
    if (provider === "filesystem") {
      await this.writeFilesystemObject(
        objectPath,
        bytes,
        contentType,
        expectedSha256,
      );
      return;
    }
    if (provider !== "s3") {
      throw new Error("Server-mediated object uploads are not enabled");
    }
    const entityId = objectPath.slice("/objects/".length);
    const entityDir = `${this.getPrivateObjectDir().replace(/\/+$/g, "")}/`;
    const { bucketName, objectName } = parseObjectPath(
      `${entityDir}${entityId}`,
    );
    const client = this.genericS3ClientFactory();
    const objectFile = new S3StoredObjectFile(
      client,
      bucketName,
      objectName,
      true,
    );
    const [exists] = await objectFile.exists();
    if (exists) throw new ObjectAlreadyExistsError();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: objectName,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: contentType,
          CacheControl: "private, no-store, max-age=0",
          Metadata: { "content-sha256": expectedSha256 },
        }),
      );
    } catch (error) {
      if (isCreateConflict(error)) throw new ObjectAlreadyExistsError();
      // A provider/network timeout may happen after the remote commit. Make a
      // best-effort idempotent delete so the failed request cannot leave an
      // untracked private object. Lifecycle cleanup remains a release control
      // for the rare case where both write and reconciliation are unavailable.
      try {
        await objectFile.delete();
      } catch {
        throw new Error("S3 write outcome could not be safely reconciled");
      }
      throw error;
    }
  }

  async getObjectEntityFile(objectPath: string): Promise<StoredObjectFile> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const entityId = objectPath.slice("/objects/".length);
    if (!entityId || entityId.startsWith("/") || entityId.includes("..")) {
      throw new ObjectNotFoundError();
    }
    const entityDir = `${this.getPrivateObjectDir().replace(/\/+$/g, "")}/`;
    const objectFile = getStoredObject(
      `${entityDir}${entityId}`,
      this.genericS3ClientFactory,
    );
    const [exists] = await objectFile.exists();
    if (!exists) throw new ObjectNotFoundError();
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (
      getObjectStorageProvider() === "filesystem" ||
      getObjectStorageProvider() === "s3"
    ) {
      const relativeMatch = rawPath.match(
        /^\/api\/storage\/uploads\/local\/([0-9a-f-]{36})$/,
      );
      if (relativeMatch) return `/objects/uploads/${relativeMatch[1]}`;
    }

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
    if (getObjectStorageProvider() === "filesystem") {
      const publicAppUrl = getPublicAppUrl();
      const uploadPrefix = "/api/storage/uploads/local/";
      if (publicAppUrl && url.origin === new URL(publicAppUrl).origin) {
        if (url.pathname.startsWith(uploadPrefix)) {
          const uploadId = url.pathname.slice(uploadPrefix.length);
          if (/^[0-9a-f-]{36}$/.test(uploadId)) {
            return `/objects/uploads/${uploadId}`;
          }
        }
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
