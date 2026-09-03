import { Readable } from "stream";
import { randomUUID } from "node:crypto";
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
import { extractLocalPdfCredentialSuggestions } from "../lib/localPdfExtraction";
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
  type AllowedUploadContentType,
  findActiveUploadGrant,
  hasAllowedUploadSignature,
  MalwareDetectedError,
  MalwareQuarantineCleanupError,
  MalwareScanBusyError,
  MalwareScanUnavailableError,
  MAX_UPLOAD_BYTES,
  processUploadSecurity,
  finalizeUploadGrantProcessing,
  reserveUploadGrantFailureCleanup,
  reserveUploadGrantForProcessing,
  rollbackUploadGrantProcessing,
  UPLOAD_GRANT_TTL_MS,
  UploadSecurityBusyError,
  UploadSecurityRejectedError,
  UploadSecurityUnavailableError,
  validateUploadedObject,
} from "../lib/uploadSecurity";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

function actorFacilityRateLimitKey(req: Request): string {
  const actor = getUser(req);
  return `facility:${actor.facilityId}:actor:${actor.id}`;
}

const uploadUrlRateLimit = rateLimit({
  name: "upload-url",
  max: 30,
  windowMs: 10 * 60_000,
  keyGenerator: actorFacilityRateLimitKey,
});
const localUploadRateLimit = rateLimit({
  name: "local-object-upload",
  max: 30,
  windowMs: 10 * 60_000,
  keyGenerator: actorFacilityRateLimitKey,
});
export const MAX_ACTIVE_LOCAL_UPLOADS = 1;
const UPLOAD_CLEANUP_DISPOSITION_HEADER = "X-Upload-Cleanup-Disposition";
const UPLOAD_CLEANUP_CONFIRMED = "confirmed";
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
 * Acquire the single server-mediated upload slot before express.raw retains an
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
    res.status(503).json({ error: "Upload security processing is busy" });
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
 * grant. Bytes pass the configured fail-closed security processor before any
 * sanitized result becomes durable.
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

    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const contentType = (req.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      bytes.length <= 0 ||
      bytes.length > MAX_UPLOAD_BYTES ||
      !ALLOWED_UPLOAD_CONTENT_TYPE.test(contentType) ||
      !hasAllowedUploadSignature(bytes, contentType)
    ) {
      res.status(400).json({ error: "Uploaded file does not match its grant" });
      return;
    }

    const objectPath = `/objects/uploads/${uploadId}`;
    const user = getUser(req);
    const processingToken = randomUUID();
    const grant = await reserveUploadGrantForProcessing(
      objectPath,
      user.id,
      bytes.length,
      contentType as AllowedUploadContentType,
      processingToken,
    );
    if (!grant) {
      res.status(403).json({ error: "Upload grant is missing or expired" });
      return;
    }

    let writeAttempted = false;
    let finalized = false;
    let storedObjectFile: StoredObjectFile | undefined;
    const localPdfReviewRequested =
      contentType === "application/pdf" &&
      req.get("x-healthdocs-pdf-text") === "review";
    try {
      // PDFs are rebuilt as image-only PDFs; raster input becomes fresh JPEG.
      // The legacy Windows
      // provider returns only bytes that received its configured verdict.
      // Persist only the processor result, never the browser-supplied buffer.
      const processed = await processUploadSecurity(bytes, contentType, {
        extractPdfText: localPdfReviewRequested,
      });

      if (localPdfReviewRequested) {
        const localExtraction = processed.extractedText
          ? extractLocalPdfCredentialSuggestions(processed.extractedText)
          : null;
        try {
          const rolledBack = await rollbackUploadGrantProcessing(
            grant.id,
            user.id,
            objectPath,
            processingToken,
          );
          if (!rolledBack) {
            throw new Error("Local PDF review grant release lost ownership");
          }
          const removed = await db
            .delete(uploadGrantsTable)
            .where(
              and(
                eq(uploadGrantsTable.id, grant.id),
                eq(uploadGrantsTable.requestedBy, user.id),
                eq(uploadGrantsTable.objectPath, objectPath),
                eq(uploadGrantsTable.status, "pending"),
              ),
            )
            .returning({ id: uploadGrantsTable.id });
          if (removed.length !== 1) {
            throw new Error("Local PDF review grant removal was not confirmed");
          }
        } catch (cleanupError) {
          req.log.error(
            safeErrorLogFields(cleanupError),
            "Failed to remove ephemeral local PDF review grant",
          );
          res.status(500).json({ error: "Failed to review PDF" });
          return;
        }

        // Review is deliberately ephemeral: neither the original nor rebuilt
        // bytes are written to object storage. Saving the credential later
        // performs a fresh, normal upload and sanitizer pass.
        res.setHeader("Cache-Control", "private, no-store, max-age=0");
        res.setHeader(
          UPLOAD_CLEANUP_DISPOSITION_HEADER,
          UPLOAD_CLEANUP_CONFIRMED,
        );
        if (localExtraction) {
          res.status(200).json({ localExtraction });
        } else {
          res.status(204).end();
        }
        return;
      }

      writeAttempted = true;
      await objectStorageService.writeServerMediatedObject(
        objectPath,
        processed.bytes,
        processed.contentType,
        processed.sha256,
      );
      storedObjectFile =
        await objectStorageService.getObjectEntityFile(objectPath);
      // Re-read provider-observed metadata and bytes, verify the signature and
      // SHA-256, then atomically replace the original grant declaration with
      // the processed object metadata while it is still owned and active.
      const storedObject = await validateUploadedObject(storedObjectFile);
      if (
        storedObject.sha256 !== processed.sha256 ||
        storedObject.contentType !== processed.contentType ||
        storedObject.size !== processed.bytes.length
      ) {
        throw new Error("Stored object differs from the processed upload");
      }
      const grantUpdated = await finalizeUploadGrantProcessing(
        grant.id,
        user.id,
        objectPath,
        processingToken,
        storedObject.size,
        storedObject.contentType as AllowedUploadContentType,
        storedObject.sha256,
      );
      if (!grantUpdated) {
        throw new Error("Upload grant expired before processing completed");
      }
      finalized = true;
      res.status(204).end();
    } catch (error) {
      if (
        error instanceof ObjectAlreadyExistsError ||
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        try {
          const rolledBack = await rollbackUploadGrantProcessing(
            grant.id,
            user.id,
            objectPath,
            processingToken,
          );
          if (!rolledBack) {
            throw new Error("Conflicting upload grant rollback lost ownership");
          }
        } catch (cleanupError) {
          req.log.error(
            safeErrorLogFields(cleanupError),
            "Failed to release conflicting upload grant",
          );
          res.status(500).json({ error: "Failed to store object" });
          return;
        }
        res.status(409).json({ error: "Object already exists" });
        return;
      }

      if (!finalized && writeAttempted) {
        // Claim exclusive cleanup ownership before touching a possibly durable
        // object. A failed CAS can mean finalization committed despite an
        // ambiguous database response; deleting in that case could corrupt a
        // credential that has already linked the processed object.
        const cleanupToken = randomUUID();
        let ownsCleanup = false;
        try {
          ownsCleanup = await reserveUploadGrantFailureCleanup(
            grant.id,
            user.id,
            objectPath,
            processingToken,
            cleanupToken,
          );
        } catch (cleanupError) {
          req.log.error(
            safeErrorLogFields(cleanupError),
            "Failed to reserve rejected upload cleanup",
          );
          res.status(500).json({ error: "Failed to store object" });
          return;
        }
        if (!ownsCleanup) {
          req.log.error(
            { errorName: "UploadCleanupOwnershipLost" },
            "Rejected upload cleanup did not own the grant",
          );
          res.status(500).json({ error: "Failed to store object" });
          return;
        }

        try {
          storedObjectFile ??=
            await objectStorageService.getObjectEntityFile(objectPath);
          await objectStorageService.deleteObject(storedObjectFile);
        } catch (cleanupError) {
          if (!(cleanupError instanceof ObjectNotFoundError)) {
            req.log.error(
              safeErrorLogFields(cleanupError),
              "Failed to remove rejected server-mediated upload",
            );
            res.status(500).json({ error: "Failed to store object" });
            return;
          }
        }

        try {
          const rolledBack = await rollbackUploadGrantProcessing(
            grant.id,
            user.id,
            objectPath,
            cleanupToken,
          );
          if (!rolledBack) {
            throw new Error("Rejected upload grant cleanup lost ownership");
          }
        } catch (cleanupError) {
          req.log.error(
            safeErrorLogFields(cleanupError),
            "Failed to release rejected upload grant",
          );
          res.status(500).json({ error: "Failed to store object" });
          return;
        }
      } else if (!finalized) {
        try {
          const rolledBack = await rollbackUploadGrantProcessing(
            grant.id,
            user.id,
            objectPath,
            processingToken,
          );
          if (!rolledBack) {
            throw new Error("Rejected upload grant rollback lost ownership");
          }
        } catch (cleanupError) {
          req.log.error(
            safeErrorLogFields(cleanupError),
            "Failed to release rejected upload grant",
          );
          res.status(500).json({ error: "Failed to store object" });
          return;
        }
      }

      // The grant rollback and, when a write was attempted, durable-object
      // cleanup both completed. Tell the same-origin client it must not issue
      // a second DELETE that would turn this terminal rejection into a
      // misleading cleanup failure. Do not emit this header from any branch
      // where cleanup ownership or provider deletion remains uncertain.
      if (!(error instanceof MalwareQuarantineCleanupError)) {
        try {
          const removed = await db
            .delete(uploadGrantsTable)
            .where(
              and(
                eq(uploadGrantsTable.id, grant.id),
                eq(uploadGrantsTable.requestedBy, user.id),
                eq(uploadGrantsTable.objectPath, objectPath),
                eq(uploadGrantsTable.status, "pending"),
              ),
            )
            .returning({ id: uploadGrantsTable.id });
          if (removed.length === 1) {
            res.setHeader(
              UPLOAD_CLEANUP_DISPOSITION_HEADER,
              UPLOAD_CLEANUP_CONFIRMED,
            );
          }
        } catch (cleanupError) {
          req.log.error(
            safeErrorLogFields(cleanupError),
            "Failed to remove rejected upload grant",
          );
          res.status(500).json({ error: "Failed to store object" });
          return;
        }
      }

      if (
        error instanceof UploadSecurityRejectedError ||
        error instanceof MalwareDetectedError
      ) {
        res.status(422).json({ error: "Uploaded file failed security checks" });
        return;
      }
      if (
        error instanceof UploadSecurityBusyError ||
        error instanceof MalwareScanBusyError
      ) {
        res.setHeader("Retry-After", "1");
        res.status(503).json({ error: "Upload security processing is busy" });
        return;
      }
      if (
        error instanceof UploadSecurityUnavailableError ||
        error instanceof MalwareScanUnavailableError ||
        error instanceof MalwareQuarantineCleanupError
      ) {
        req.log.error(
          safeErrorLogFields(error),
          "Server-mediated upload security processing failed closed",
        );
        res
          .status(503)
          .json({ error: "Upload security processing is unavailable" });
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
 * Only filesystem/S3 may mint the guarded same-origin endpoint above. Direct
 * provider upload URLs are deliberately disabled because they would bypass
 * the server-side sanitizer.
 */
router.post(
  "/storage/uploads/request-url",
  requireAuth,
  uploadUrlRateLimit,
  requireDocumentUploadsEnabled,
  requireServerMediatedUploadProvider,
  async (req: Request, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }

    // Server-side upload policy: JPEG/PNG/PDF documents at most 8 MiB.
    // Every accepted document is decoded and rebuilt by
    // the guarded byte-ingress route before it becomes durable.
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
        // A valid cleanup replay with no actor-owned grant is a successful
        // no-op. This keeps the endpoint idempotent when the server already
        // removed a rejected/review grant but the browser did not receive the
        // first response. It also keeps missing and foreign grants opaque: no
        // provider lookup, credential query, deletion or audit occurs here.
        if (!grant) return { kind: "absent" as const };
        // The sanitizer owns both the grant and its object while processing.
        // Returning the same 404 avoids an existence/state oracle and ensures
        // cleanup cannot delete bytes underneath an active processing attempt.
        if (grant.status === "processing") {
          return { kind: "not_found" as const };
        }

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

        try {
          const objectFile =
            await objectStorageService.getObjectEntityFile(objectPath);
          await objectStorageService.deleteObject(objectFile);
        } catch (error) {
          // The locked, actor-owned, unlinked grant is the authority for this
          // cleanup. If its object is already absent, finishing the grant and
          // audit cleanup is idempotent and does not reveal another actor's
          // object state.
          if (!(error instanceof ObjectNotFoundError)) throw error;
        }
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
      const isLinkedOwner =
        hasObjectAcl && linked.some((entry) => entry.employeeId === user.id);
      // An unlinked upload has no object ACL until credential creation. The
      // processed, unclaimed grant is itself the short-lived authorization:
      // findActiveUploadGrant already binds the exact object path to this user
      // and requires the processed lifecycle, integrity hash, and expiry.
      const isPendingOwner = linked.length === 0 && pendingGrant != null;
      const isOwner = isLinkedOwner || isPendingOwner;
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
