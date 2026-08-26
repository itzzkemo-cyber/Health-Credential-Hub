
import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, credentialsTable, uploadGrantsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

import { requireAuth, getUser, MANAGER_ROLES } from "../lib/auth";
import { getCredentialScopedUsers, logAudit } from "../lib/helpers";
import { rateLimit } from "../lib/rateLimit";
import { safeErrorLogFields } from "../lib/safeError";
import { ObjectPermission } from "../lib/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import {
  ALLOWED_UPLOAD_CONTENT_TYPE,
  findActiveUploadGrant,
  MAX_UPLOAD_BYTES,
  UPLOAD_GRANT_TTL_MS,
} from "../lib/uploadSecurity";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const uploadUrlRateLimit = rateLimit({
  name: "upload-url",
  max: 30,
  windowMs: 10 * 60_000,
});

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
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * requireAuth so public callers cannot mint write-capable URLs.
 */
router.post(
  "/storage/uploads/request-url",
  requireAuth,
  uploadUrlRateLimit,
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
        await objectStorageService.getObjectEntityUploadURL(contentType.toLowerCase());
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
      req.log.error(
        safeErrorLogFields(error),
        "Error generating upload URL",
      );
      res.status(500).json({ error: "Failed to generate upload URL" });
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
        const linkedOwner = (await getCredentialScopedUsers(user)).find((employee) =>
          linkedIds.has(employee.id),
        );
        canManage = linkedOwner != null;
        if (linkedOwner) auditFacilityId = linkedOwner.facilityId;
      }
      if (!isOwner && !canManage) {
        // Retained objects with no active credential link must not be
        // distinguishable from absent documents after soft deletion.
        const notFound = linked.length === 0 && pendingGrant == null;
        res.status(notFound ? 404 : 403).json({
          error: notFound ? "Object not found" : "Forbidden",
        });
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
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
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
