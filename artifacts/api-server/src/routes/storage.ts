import { Readable } from "stream";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import {
  raw,
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  auditLogsTable,
  credentialsTable,
  db,
  uploadGrantsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

import { requireAuth, getUser, MANAGER_ROLES } from "../lib/auth";
import {
  areDocumentUploadsEnabled,
  DOCUMENT_UPLOADS_DISABLED_CODE,
} from "../lib/documentUploads";
import { getCredentialScopedUsers, logAudit } from "../lib/helpers";
import { rateLimit } from "../lib/rateLimit";
import { safeErrorLogFields } from "../lib/safeError";
import { isFreshActiveSessionActor } from "../lib/sessionFreshness";
import { ObjectPermission } from "../lib/objectAcl";
import {
  getObjectStorageProvider,
  ObjectAlreadyExistsError,
  ObjectNotFoundError,
  ObjectStorageService,
  type StoredObjectFile,
} from "../lib/objectStorage";
import {
  ALLOWED_UPLOAD_CONTENT_TYPE,
  findActiveUploadGrant,
  hasAllowedUploadSignature,
  MalwareDetectedError,
  MalwareQuarantineCleanupError,
  MalwareScanBusyError,
  MalwareScanUnavailableError,
  MAX_UPLOAD_BYTES,
  scanUploadForMalware,
  UPLOAD_GRANT_TTL_MS,
  validateUploadedObject,
} from "../lib/uploadSecurity";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const uploadUrlRateLimit = rateLimit({
  name: "upload-url",
  max: 30,
  windowMs: 10 * 60_000,
});
const localUploadRateLimit = rateLimit({
  name: "local-object-upload",
  max: 30,
  windowMs: 10 * 60_000,
});
export const MAX_ACTIVE_LOCAL_UPLOADS = 1;
let activeLocalUploads = 0;

function requireServerMediatedUploadProvider(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const provider = getObjectStorageProvider();
  if (provider !== "filesystem" && provider !== "s3") {
    res.status(404).json({ error: "Upload endpoint is not enabled" });
    return;
  }
  next();
}

function requireDocumentUploadsEnabled(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!areDocumentUploadsEnabled()) {
    res.status(503).json({
      error: "Document uploads are disabled",
      code: DOCUMENT_UPLOADS_DISABLED_CODE,
    });
    return;
  }
  next();
}

/**
 * Acquire the single local Defender/upload slot before express.raw retains an
 * up-to-8MB body. Concurrent callers fail fast instead of building an
 * in-process queue of sensitive document buffers.
 */
function requireLocalUploadSlot(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (activeLocalUploads >= MAX_ACTIVE_LOCAL_UPLOADS) {
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "Upload security scanning is busy" });
    return;
  }

  activeLocalUploads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeLocalUploads -= 1;
  };
  res.once("finish", release);
  res.once("close", release);
  next();
}

/**
 * PUT /storage/uploads/local/:uploadId
 *
 * The filesystem and generic S3 profiles use this same-origin endpoint. It is
 * session-authenticated, CSRF-guarded, and backed by a short-lived database
 * grant. Bytes are checked and scanned before becoming durable; if the runtime
 * has no supported malware scanner, the upload fails closed.
 */
router.put(
  "/storage/uploads/local/:uploadId",
  requireAuth,
  localUploadRateLimit,
  requireDocumentUploadsEnabled,
  requireServerMediatedUploadProvider,
  requireLocalUploadSlot,
  raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  async (req: Request, res: Response) => {
    const uploadId = req.params.uploadId;
    if (typeof uploadId !== "string" || !/^[0-9a-f-]{36}$/.test(uploadId)) {
      res.status(400).json({ error: "Invalid upload identifier" });
      return;
    }
    if (req.get("if-none-match") !== "*") {
      res.status(428).json({ error: "Create-only upload header is required" });
      return;
    }

    const objectPath = `/objects/uploads/${uploadId}`;
    const user = getUser(req);
    const grant = await findActiveUploadGrant(objectPath, user.id);
    if (!grant) {
      res.status(403).json({ error: "Upload grant is missing or expired" });
      return;
    }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const contentType = (req.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      bytes.length !== grant.declaredSize ||
      bytes.length <= 0 ||
      bytes.length > MAX_UPLOAD_BYTES ||
      contentType !== grant.declaredContentType.toLowerCase() ||
      !ALLOWED_UPLOAD_CONTENT_TYPE.test(contentType) ||
      !hasAllowedUploadSignature(bytes, contentType)
    ) {
      res.status(400).json({ error: "Uploaded file does not match its grant" });
      return;
    }

    let createdObject = false;
    let storedObjectFile: StoredObjectFile | undefined;
    try {
      // Stage the exact in-memory bytes under a random quarantine name and
      // require a clean configured scanner verdict before making the object
      // durable. A missing scanner is an availability failure, never a bypass.
      await scanUploadForMalware(bytes);
      const scannedSha256 = createHash("sha256").update(bytes).digest("hex");
      await objectStorageService.writeServerMediatedObject(
        objectPath,
        bytes,
        contentType,
        scannedSha256,
      );
      createdObject = true;
      storedObjectFile =
        await objectStorageService.getObjectEntityFile(objectPath);
      // Re-read provider-observed metadata and bytes, enforce the grant again,
      // verify the signature, and record the SHA-256 integrity hash.
      const storedObject = await validateUploadedObject(
        storedObjectFile,
        grant,
      );
      if (storedObject.sha256 !== scannedSha256) {
        throw new Error("Stored object differs from the screened upload");
      }
      res.status(204).end();
    } catch (error) {
      if (error instanceof ObjectAlreadyExistsError) {
        res.status(409).json({ error: "Object already exists" });
        return;
      }

      if (createdObject) {
        try {
          storedObjectFile ??=
            await objectStorageService.getObjectEntityFile(objectPath);
          await objectStorageService.deleteObject(storedObjectFile);
        } catch (cleanupError) {
          req.log.error(
            safeErrorLogFields(cleanupError),
            "Failed to remove rejected server-mediated upload",
          );
          res.status(500).json({ error: "Failed to store object" });
          return;
        }
      }

      if (error instanceof MalwareDetectedError) {
        res.status(422).json({ error: "Uploaded file failed security checks" });
        return;
      }
      if (error instanceof MalwareScanBusyError) {
        res.setHeader("Retry-After", "1");
        res.status(503).json({ error: "Upload security scanning is busy" });
        return;
      }
      if (
        error instanceof MalwareScanUnavailableError ||
        error instanceof MalwareQuarantineCleanupError
      ) {
        req.log.error(
          safeErrorLogFields(error),
          "Server-mediated upload security scan failed closed",
        );
        res
          .status(503)
          .json({ error: "Upload security scanning is unavailable" });
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        res.status(409).json({ error: "Object already exists" });
        return;
      }
      req.log.error(
        safeErrorLogFields(error),
        "Error storing server-mediated object",
      );
      res.status(500).json({ error: "Failed to store object" });
    }
  },
);

/**
 * Defense-in-depth for user-uploaded content served in-browser: never let the
 * browser sniff a different content type, and neuter any active content
 * (e.g. scripted SVG/HTML smuggled past the type policy) when the file is
 * opened directly in a tab. PDFs are exempt from the CSP sandbox because
 * Chrome's built-in PDF viewer refuses to render inside a sandboxed document.
 */
function hardenServedObjectHeaders(res: Response): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const servedType = String(res.getHeader("Content-Type") ?? "");
  if (servedType !== "application/pdf") {
    res.setHeader("Content-Security-Policy", "sandbox");
  }
}

/**
 * POST /storage/uploads/request-url
 *
 * Request a controlled URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * GCS/OCI return a short-lived provider URL; filesystem/S3 return the guarded
 * same-origin endpoint above. Authentication prevents public callers from
 * minting either kind of write capability.
 */
router.post(
  "/storage/uploads/request-url",
  requireAuth,
  uploadUrlRateLimit,
  requireDocumentUploadsEnabled,
  async (req: Request, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    // Server-side upload policy, mirroring the client cap: credential
    // documents are images or PDFs, at most 8 MB (the OCR provider cap).
    // Explicit subtype allowlist: image/svg+xml is deliberately excluded —
    // SVG can carry scripts, and stored documents are viewable in-browser.
    if (
      parsed.data.size <= 0 ||
      parsed.data.size > MAX_UPLOAD_BYTES ||
      !ALLOWED_UPLOAD_CONTENT_TYPE.test(parsed.data.contentType) ||
      parsed.data.name.length > 255 ||
      /[\u0000-\u001f\u007f]/.test(parsed.data.name)
    ) {
      res.status(400).json({ error: "Unsupported file type or size" });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;

      const { uploadURL, requiredHeaders } =
        await objectStorageService.getObjectEntityUploadURL(
          contentType.toLowerCase(),
        );
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);
      const user = getUser(req);
      await db.insert(uploadGrantsTable).values({
        objectPath,
        requestedBy: user.id,
        fileName: name,
        declaredSize: size,
        declaredContentType: contentType.toLowerCase(),
        expiresAt: new Date(Date.now() + UPLOAD_GRANT_TTL_MS),
      });

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          requiredHeaders,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error(safeErrorLogFields(error), "Error generating upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

/**
 * DELETE /storage/uploads/:uploadId
 *
 * Remove an abandoned private upload without creating an object-existence
 * oracle. The actor and upload grant are locked in the same order used by the
 * credential mutation flow, so a concurrent credential link either completes
 * first (and blocks deletion) or observes that the grant was removed.
 */
router.delete(
  "/storage/uploads/:uploadId",
  requireAuth,
  async (req: Request, res: Response) => {
    const uploadId = req.params.uploadId;
    if (
      typeof uploadId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        uploadId,
      )
    ) {
      res.status(404).json({ error: "Upload not found" });
      return;
    }

    const objectPath = `/objects/uploads/${uploadId}`;
    const requestUser = getUser(req);

    try {
      const result = await db.transaction(async (tx) => {
        const actor = (
          await tx
            .select()
            .from(usersTable)
            .where(eq(usersTable.id, requestUser.id))
            .for("update")
        )[0];
        if (!isFreshActiveSessionActor(actor, requestUser)) {
          return { kind: "unauthorized" as const };
        }

        // Ownership is derived only from the server-issued database grant.
        // Manager and system-admin roles never gain delete access to another
        // employee's abandoned upload, regardless of facility scope.
        const grant = (
          await tx
            .select()
            .from(uploadGrantsTable)
            .where(
              and(
                eq(uploadGrantsTable.objectPath, objectPath),
                eq(uploadGrantsTable.requestedBy, actor.id),
              ),
            )
            .for("update")
        )[0];
        if (!grant) return { kind: "not_found" as const };

        // Deliberately include soft-deleted credentials. Their retained audit
        // history still owns the private object until the approved retention
        // workflow removes both records.
        const linkedCredential = (
          await tx
            .select({ id: credentialsTable.id })
            .from(credentialsTable)
            .where(eq(credentialsTable.fileUrl, objectPath))
            .limit(1)
        )[0];
        if (linkedCredential) return { kind: "not_found" as const };

        const objectFile =
          await objectStorageService.getObjectEntityFile(objectPath);
        await objectStorageService.deleteObject(objectFile);
        await tx
          .delete(uploadGrantsTable)
          .where(
            and(
              eq(uploadGrantsTable.id, grant.id),
              eq(uploadGrantsTable.requestedBy, actor.id),
              eq(uploadGrantsTable.objectPath, objectPath),
            ),
          );
        await tx.insert(auditLogsTable).values({
          userId: actor.id,
          facilityId: actor.facilityId,
          userName: actor.name,
          userNameAr: actor.nameAr,
          action: "Deleted unlinked private upload",
          actionAr: "حذف رفع خاص غير مرتبط",
          target: "Unlinked private upload",
          targetAr: "رفع خاص غير مرتبط",
          details: null,
          ipAddress: req.ip ?? null,
        });
        return { kind: "deleted" as const };
      });

      if (result.kind === "unauthorized") {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (result.kind === "not_found") {
        res.status(404).json({ error: "Upload not found" });
        return;
      }
      res.status(204).end();
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Upload not found" });
        return;
      }
      req.log.error(
        safeErrorLogFields(error),
        "Error deleting unlinked private upload",
      );
      res.status(500).json({ error: "Failed to delete unlinked upload" });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve credential document files from PRIVATE_OBJECT_DIR.
 * Requires a logged-in session. Manager roles may view documents only inside
 * their server-side facility/team scope; other users only documents they own
 * (ACL owner = the credential's employee id, set when the credential is saved).
 */
router.get(
  "/storage/objects/*path",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.path;
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${wildcardPath}`;
      const objectFile =
        await objectStorageService.getObjectEntityFile(objectPath);

      const user = getUser(req);
      const hasObjectAcl = await objectStorageService.canAccessObjectEntity({
        userId: String(user.id),
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });
      const linked = await db
        .select({ employeeId: credentialsTable.employeeId })
        .from(credentialsTable)
        .where(
          and(
            eq(credentialsTable.fileUrl, objectPath),
            isNull(credentialsTable.deletedAt),
          ),
        );
      const pendingGrant =
        linked.length === 0
          ? await findActiveUploadGrant(objectPath, user.id)
          : null;
      const isOwner =
        hasObjectAcl &&
        (linked.some((entry) => entry.employeeId === user.id) ||
          pendingGrant != null);
      let canManage = false;
      let auditFacilityId = user.facilityId;
      if (!isOwner && MANAGER_ROLES.includes(user.role)) {
        const linkedIds = new Set(linked.map((entry) => entry.employeeId));
        const linkedOwner = (await getCredentialScopedUsers(user)).find(
          (employee) => linkedIds.has(employee.id),
        );
        canManage = linkedOwner != null;
        if (linkedOwner) auditFacilityId = linkedOwner.facilityId;
      }
      if (!isOwner && !canManage) {
        // Do not expose whether a guessed object path exists, is linked to a
        // credential, or belongs to another facility/team.
        res.status(404).json({ error: "Object not found" });
        return;
      }

      const response = await objectStorageService.downloadObject(objectFile);

      await logAudit(
        user,
        "Viewed credential document",
        "عرض ملف وثيقة",
        "Private credential document",
        "ملف وثيقة خاص",
        undefined,
        req.ip,
        auditFacilityId,
      );

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      // This route is always authenticated/private even if legacy object
      // metadata is inconsistent. Never let such a response enter a shared or
      // reusable browser cache.
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      hardenServedObjectHeaders(res);

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        await pipeline(nodeStream, res);
      } else {
        res.end();
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        req.log.error(
          safeErrorLogFields(error),
          "Error streaming private object",
        );
        if (!res.destroyed) {
          res.destroy(error instanceof Error ? error : undefined);
        }
        return;
      }
      if (error instanceof ObjectNotFoundError) {
        req.log.warn(safeErrorLogFields(error), "Object not found");
        res.status(404).json({ error: "Object not found" });
        return;
      }
      req.log.error(safeErrorLogFields(error), "Error serving object");
      res.status(500).json({ error: "Failed to serve object" });
    }
  },
);

export default router;
