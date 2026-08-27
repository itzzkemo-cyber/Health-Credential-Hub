import type { BucketMetadata } from "@google-cloud/storage";

import {
  headOciBucket,
  objectStorageClient,
  probeFilesystemObjectStorage,
  validateFilesystemObjectStorageEnvironment,
  validateOciObjectStorageEnvironment,
} from "./objectStorage";

const PRODUCTION_GCS_LOCATION = "ME-CENTRAL2";

type ObjectStorageReadiness = "configured" | "verified";

type BucketMetadataReader = (bucketName: string) => Promise<BucketMetadata>;
type OciBucketProbe = (bucketName: string) => Promise<void>;
type FilesystemProbe = () => Promise<void>;

interface StorageReadinessOptions {
  env?: NodeJS.ProcessEnv;
  readBucketMetadata?: BucketMetadataReader;
  probeOciBucket?: OciBucketProbe;
  probeFilesystemStorage?: FilesystemProbe;
}

export class ObjectStorageReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStorageReadinessError";
    Object.setPrototypeOf(this, ObjectStorageReadinessError.prototype);
  }
}

function getConfiguredBucketName(privateObjectDir: string): string {
  const normalized = privateObjectDir.trim().replace(/\/+$/g, "");
  const pathParts = normalized.split("/");
  if (
    pathParts.length !== 3 ||
    pathParts[0] !== "" ||
    !pathParts[1] ||
    pathParts[2] !== "private"
  ) {
    throw new ObjectStorageReadinessError(
      "PRIVATE_OBJECT_DIR must be set to /bucket-name/private",
    );
  }
  return pathParts[1];
}

async function readBucketMetadata(bucketName: string): Promise<BucketMetadata> {
  // Bucket metadata is a read-only request. It verifies both that the bucket
  // exists and that the runtime identity can inspect its security posture.
  const [metadata] = await objectStorageClient
    .bucket(bucketName)
    .getMetadata();
  return metadata;
}

/**
 * Verify the private object store used by the API.
 *
 * Development and tests deliberately avoid a cloud round trip. Production
 * readiness always verifies bucket reachability. GCS additionally verifies
 * the approved Dammam location, PAP, and uniform bucket-level access; OCI
 * security posture is enforced by its deployment preflight because the S3
 * compatibility credentials cannot inspect those bucket controls.
 */
export async function checkObjectStorageReadiness(
  options: StorageReadinessOptions = {},
): Promise<ObjectStorageReadiness> {
  const env = options.env ?? process.env;
  const privateObjectDir = env.PRIVATE_OBJECT_DIR?.trim();
  if (!privateObjectDir) {
    throw new ObjectStorageReadinessError(
      "Private object storage is not configured",
    );
  }

  if (env.NODE_ENV !== "production") return "configured";

  const provider = env.OBJECT_STORAGE_PROVIDER?.trim().toLowerCase();
  if (!provider) {
    throw new ObjectStorageReadinessError(
      "Object storage provider is not configured",
    );
  }
  if (provider !== "gcs" && provider !== "oci" && provider !== "filesystem") {
    throw new ObjectStorageReadinessError(
      "Object storage provider is not supported",
    );
  }

  if (provider === "oci") {
    try {
      validateOciObjectStorageEnvironment(env);
    } catch {
      throw new ObjectStorageReadinessError(
        "OCI object storage is not configured for the approved region",
      );
    }
    const bucketName = getConfiguredBucketName(privateObjectDir);
    await (options.probeOciBucket ?? headOciBucket)(bucketName);
    // OCI's S3 compatibility credentials can prove private bucket reachability,
    // but not IAM, public-access, versioning, CORS, or lifecycle posture. Those
    // controls remain an OCI deployment preflight/release-gate responsibility.
    return "verified";
  }

  if (provider === "filesystem") {
    try {
      validateFilesystemObjectStorageEnvironment(env);
      getConfiguredBucketName(privateObjectDir);
    } catch {
      throw new ObjectStorageReadinessError(
        "Filesystem object storage is not configured for the local tunnel profile",
      );
    }
    await (options.probeFilesystemStorage ?? probeFilesystemObjectStorage)();
    // Directory ACLs, volume encryption, backup posture, and restore drills are
    // enforced by the local production preflight.
    return "verified";
  }

  if (!env.GOOGLE_CLOUD_PROJECT?.trim()) {
    throw new ObjectStorageReadinessError(
      "Google Cloud project is not configured",
    );
  }

  const bucketName = getConfiguredBucketName(privateObjectDir);
  const metadata = await (options.readBucketMetadata ?? readBucketMetadata)(
    bucketName,
  );

  if (metadata.name !== bucketName) {
    throw new ObjectStorageReadinessError(
      "Configured GCS bucket metadata could not be verified",
    );
  }
  if (metadata.location?.toUpperCase() !== PRODUCTION_GCS_LOCATION) {
    throw new ObjectStorageReadinessError(
      "Configured GCS bucket is outside the approved region",
    );
  }
  if (
    metadata.iamConfiguration?.publicAccessPrevention?.toLowerCase() !==
    "enforced"
  ) {
    throw new ObjectStorageReadinessError(
      "Configured GCS bucket does not enforce public access prevention",
    );
  }
  if (
    metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true
  ) {
    throw new ObjectStorageReadinessError(
      "Configured GCS bucket does not enforce uniform bucket-level access",
    );
  }

  return "verified";
}
