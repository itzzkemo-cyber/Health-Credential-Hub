import type { BucketMetadata } from "@google-cloud/storage";

import { areDocumentUploadsEnabled } from "./documentUploads";
import {
  headOciBucket,
  headS3Bucket,
  objectStorageClient,
  probeFilesystemObjectStorage,
  validateFilesystemObjectStorageEnvironment,
  validateOciObjectStorageEnvironment,
  validateS3ObjectStorageEnvironment,
} from "./objectStorage";

const PRODUCTION_GCS_LOCATION = "ME-CENTRAL2";

type ObjectStorageReadiness = "configured" | "verified";

type BucketMetadataReader = (bucketName: string) => Promise<BucketMetadata>;
type OciBucketProbe = (bucketName: string) => Promise<void>;
type S3BucketProbe = (bucketName: string) => Promise<void>;
type FilesystemProbe = () => Promise<void>;
type UploadSecurityProbe = (env: NodeJS.ProcessEnv) => Promise<void>;

async function probeConfiguredUploadSecurity(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // Keep native raster processing lazy. uploadSecurity dynamically imports its
  // database helpers only in grant operations, so this self-test initializes no
  // database connection and uses only embedded non-user fixtures.
  const { checkUploadSecurityReadiness } = await import("./uploadSecurity");
  await checkUploadSecurityReadiness({ env });
}

interface StorageReadinessOptions {
  env?: NodeJS.ProcessEnv;
  readBucketMetadata?: BucketMetadataReader;
  probeOciBucket?: OciBucketProbe;
  probeS3Bucket?: S3BucketProbe;
  probeFilesystemStorage?: FilesystemProbe;
  probeUploadSecurity?: UploadSecurityProbe;
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
  const [metadata] = await objectStorageClient.bucket(bucketName).getMetadata();
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
  if (
    provider !== "gcs" &&
    provider !== "oci" &&
    provider !== "s3" &&
    provider !== "filesystem"
  ) {
    throw new ObjectStorageReadinessError(
      "Object storage provider is not supported",
    );
  }
  const uploadsEnabled = areDocumentUploadsEnabled(env);
  if (uploadsEnabled && (provider === "gcs" || provider === "oci")) {
    throw new ObjectStorageReadinessError(
      "Document uploads require the server-mediated filesystem or S3 provider",
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

  if (provider === "s3") {
    try {
      validateS3ObjectStorageEnvironment(env);
    } catch {
      throw new ObjectStorageReadinessError(
        "S3 object storage is not configured with a safe HTTPS endpoint",
      );
    }
    const bucketName = getConfiguredBucketName(privateObjectDir);
    await (options.probeS3Bucket ?? headS3Bucket)(bucketName);
    if (uploadsEnabled) {
      await (options.probeUploadSecurity ?? probeConfiguredUploadSecurity)(env);
    }
    // Generic S3 credentials can prove bucket reachability, not that a vendor
    // bucket is private. Bucket privacy, retention, region, and key scope remain
    // explicit deployment checks; browser access is blocked by architecture.
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
    if (uploadsEnabled) {
      await (options.probeUploadSecurity ?? probeConfiguredUploadSecurity)(env);
    }
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
  if (metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) {
    throw new ObjectStorageReadinessError(
      "Configured GCS bucket does not enforce uniform bucket-level access",
    );
  }

  return "verified";
}
