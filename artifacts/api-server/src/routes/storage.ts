import { Readable } from "stream";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, credentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import { requireAuth, getUser, MANAGER_ROLES } from "../lib/auth";
import { getScopedUsers } from "../lib/helpers";
import { rateLimit } from "../lib/rateLimit";
import { ObjectPermission } from "../lib/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";

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
    const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
    // Explicit subtype allowlist: image/svg+xml is deliberately excluded —
    // SVG can carry scripts, and stored documents are viewable in-browser.
    const ALLOWED_CONTENT_TYPE =
      /^(image\/(png|jpe?g|webp|gif|avif|heic|heif)|application\/pdf)$/;
    if (
      parsed.data.size > MAX_UPLOAD_BYTES ||
      !ALLOWED_CONTENT_TYPE.test(parsed.data.contentType)
    ) {
      res.status(400).json({ error: "Unsupported file type or size" });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Error generating upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 */
router.get(
  "/storage/public-objects/*filePath",
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const response = await objectStorageService.downloadObject(file);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
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
      req.log.error({ err: error }, "Error serving public object");
      res.status(500).json({ error: "Failed to serve public object" });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve credential document files from PRIVATE_OBJECT_DIR.
 * Requires a logged-in session. Manager roles (supervisor and above) may view
 * any document; other users only documents they own (ACL owner = the
 * credential's employee id, set when the credential is saved).
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
      const isOwner = await objectStorageService.canAccessObjectEntity({
        userId: String(user.id),
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });
      let canManage = false;
      if (!isOwner && MANAGER_ROLES.includes(user.role)) {
        const linked = await db
          .select({ employeeId: credentialsTable.employeeId })
          .from(credentialsTable)
          .where(eq(credentialsTable.fileUrl, objectPath));
        const scopedIds = new Set(
          (await getScopedUsers(user)).map((employee) => employee.id),
        );
        canManage = linked.some((entry) => scopedIds.has(entry.employeeId));
      }
      if (!isOwner && !canManage) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const response = await objectStorageService.downloadObject(objectFile);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
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
        req.log.warn({ err: error }, "Object not found");
        res.status(404).json({ error: "Object not found" });
        return;
      }
      req.log.error({ err: error }, "Error serving object");
      res.status(500).json({ error: "Failed to serve object" });
    }
  },
);

export default router;
