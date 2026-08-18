import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import {
  db,
  credentialsTable,
  usersTable,
  notificationsTable,
  CREDENTIAL_TYPES,
  type CredentialType,
  type User,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireAuth, getUser, MANAGER_ROLES } from "../lib/auth";
import {
  computeStatus,
  daysUntil,
  dateStr,
  serializeCredential,
  getScopedUsers,
  getCredentialsFor,
  getPolicies,
  missingTypesFor,
  logAudit,
} from "../lib/helpers";
import {
  getObjectAclPolicy,
  setObjectAclPolicy,
  ObjectPermission,
} from "../lib/objectAcl";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { getAi } from "@workspace/integrations-gemini-ai";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

function normalizeCalendarDate(value: string): string | null {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

/**
 * Credential files now live in object storage: the client uploads to a
 * presigned URL and sends back an `/objects/...` path. Before persisting,
 * normalize the path and stamp its ACL (owner = the credential's employee,
 * private) so the storage serving route can authorize reads. Anything else —
 * including inline `data:` URLs — is rejected, so files can never be stored
 * inside the database again.
 */
async function finalizeStoredFileUrl(
  rawUrl: string,
  employeeId: number,
  actorId: number,
): Promise<string | null> {
  // Only storage paths are acceptable — external http(s) or other schemes
  // must never be persisted as credential files (provenance + phishing risk).
  if (!rawUrl.startsWith("/objects/")) return null;
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(rawUrl);
    const existingPolicy = await getObjectAclPolicy(objectFile);
    if (
      existingPolicy &&
      existingPolicy.owner !== String(actorId) &&
      existingPolicy.owner !== String(employeeId)
    ) {
      return null;
    }
    return await objectStorageService.trySetObjectEntityAclPolicy(rawUrl, {
      owner: String(employeeId),
      visibility: "private",
    });
  } catch {
    return null;
  }
}

async function canManageLinkedObject(user: User, fileUrl: string): Promise<boolean> {
  if (!MANAGER_ROLES.includes(user.role)) return false;
  const linked = await db
    .select({ employeeId: credentialsTable.employeeId })
    .from(credentialsTable)
    .where(eq(credentialsTable.fileUrl, fileUrl));
  if (linked.length === 0) return false;
  const scopedIds = new Set((await getScopedUsers(user)).map((entry) => entry.id));
  return linked.some((entry) => scopedIds.has(entry.employeeId));
}

// ---------------------------------------------------------------------------
// PUBLIC: QR verification (no auth) — id is the QR token
// ---------------------------------------------------------------------------
router.get("/credentials/:id/verify", async (req, res) => {
  const token = String(req.params.id);
  const rows = await db
    .select()
    .from(credentialsTable)
    .where(eq(credentialsTable.qrToken, token));
  const cred = rows[0];
  if (!cred || !cred.isVerified) {
    res.status(404).json({ message: "Credential not found" });
    return;
  }
  res.json({
    type: cred.customTypeName ?? cred.type,
    issuerName: cred.issuerName,
    issueDate: cred.issueDate,
    expiryDate: cred.expiryDate,
    status: computeStatus(cred.expiryDate),
    verificationCode: cred.qrToken.slice(0, 8).toUpperCase(),
  });
});

router.use("/credentials", requireAuth);

// ---------------------------------------------------------------------------
// Static paths BEFORE /:id
// ---------------------------------------------------------------------------

router.get("/credentials/expiring", async (req, res) => {
  const user = getUser(req);
  const days = Number(req.query.days ?? 90);
  const scoped = await getScopedUsers(user);
  const byId = new Map(scoped.map((u) => [u.id, u]));
  const creds = await getCredentialsFor(scoped.map((u) => u.id));
  const result = creds
    .filter((c) => {
      const d = daysUntil(c.expiryDate);
      return d >= 0 && d <= days;
    })
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
    .map((c) => serializeCredential(c, byId.get(c.employeeId)));
  res.json(result);
});

router.get("/credentials/missing", async (req, res) => {
  const user = getUser(req);
  const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;
  const departmentId = req.query.departmentId
    ? Number(req.query.departmentId)
    : null;
  let scoped = await getScopedUsers(user);
  if (employeeId != null) scoped = scoped.filter((u) => u.id === employeeId);
  if (departmentId != null)
    scoped = scoped.filter((u) => u.departmentId === departmentId);
  scoped = scoped.filter((u) => u.isActive);
  const creds = await getCredentialsFor(scoped.map((u) => u.id));
  const policies = await getPolicies(user.role === "system_admin" ? null : user.facilityId);
  const result: unknown[] = [];
  for (const u of scoped) {
    for (const t of missingTypesFor(u, creds, policies)) {
      result.push({
        employeeId: u.id,
        employeeName: u.name,
        employeeNameAr: u.nameAr,
        credentialType: t,
        required: true,
      });
    }
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// AI document reading (OCR) — Gemini vision via Replit AI Integrations
// ---------------------------------------------------------------------------

const OCR_MODEL = "gemini-2.5-flash";
// AI Integrations only accepts inline input data, capped at 8 MB.
const MAX_OCR_BYTES = 8 * 1024 * 1024;
// Same explicit allowlist as the upload presign policy in storage.ts.
const OCR_MIME_ALLOWLIST =
  /^(image\/(png|jpe?g|webp|gif|avif|heic|heif)|application\/pdf)$/i;

// Cheap in-memory per-user rate limit — every OCR call is a billed AI request.
const OCR_RATE_LIMIT = 20;
const OCR_RATE_WINDOW_MS = 10 * 60 * 1000;
const ocrCallLog = new Map<number, number[]>();

function ocrRateLimited(userId: number): boolean {
  const now = Date.now();
  const calls = (ocrCallLog.get(userId) ?? []).filter(
    (t) => now - t < OCR_RATE_WINDOW_MS,
  );
  if (calls.length >= OCR_RATE_LIMIT) {
    ocrCallLog.set(userId, calls);
    return true;
  }
  calls.push(now);
  ocrCallLog.set(userId, calls);
  return false;
}

function ocrString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function ocrDate(v: unknown): string | null {
  const s = ocrString(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

router.post("/credentials/ocr", async (req, res) => {
  const user = getUser(req);
  const { fileUrl } = req.body as { fileUrl?: string };
  if (!fileUrl || !fileUrl.startsWith("/objects/")) {
    res.status(400).json({ message: "A stored document path is required" });
    return;
  }
  if (ocrRateLimited(user.id)) {
    res.status(429).json({ message: "Too many AI reading requests, try again later" });
    return;
  }

  // Load the uploaded document from object storage.
  let buffer: Buffer;
  let mimeType: string;
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(fileUrl);

    // Fresh uploads carry no ACL yet (it is stamped when the credential is
    // saved). If the object already HAS an ACL, apply the same rule as the
    // file-serving route: managers may read any document, everyone else only
    // their own — so this endpoint cannot be used to read someone else's file.
    const aclPolicy = await getObjectAclPolicy(objectFile);
    if (aclPolicy) {
      const isOwner = await objectStorageService.canAccessObjectEntity({
        userId: String(user.id),
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });
      const canManage = isOwner ? false : await canManageLinkedObject(user, fileUrl);
      if (!isOwner && !canManage) {
        res.status(403).json({ message: "Forbidden" });
        return;
      }
    }

    if (!aclPolicy) {
      // Claim fresh (not yet saved) uploads for the caller, so a leaked
      // object path cannot be read here by other non-manager users. Saving
      // the credential re-stamps the final owner.
      await setObjectAclPolicy(objectFile, {
        owner: String(user.id),
        visibility: "private",
      });
    }

    const [metadata] = await objectFile.getMetadata();
    mimeType = String(metadata.contentType ?? "application/octet-stream");
    if (!OCR_MIME_ALLOWLIST.test(mimeType)) {
      res.status(422).json({ message: "Unsupported document type" });
      return;
    }
    if (Number(metadata.size ?? 0) > MAX_OCR_BYTES) {
      res.status(422).json({ message: "File too large for AI reading" });
      return;
    }
    const downloaded = await objectFile.download();
    buffer = downloaded[0];
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ message: "Document not found" });
      return;
    }
    req.log.error({ err: error }, "OCR: failed to load stored document");
    res.status(500).json({ message: "Failed to load stored document" });
    return;
  }

  // Ask Gemini to read the document and return structured fields.
  try {
    const prompt = [
      "You are reading a healthcare credential document (certificate, professional license, or ID card) for a Saudi hospital compliance system.",
      "Extract ONLY what is actually printed in the document. Never invent or guess values: when a field is absent or unreadable, return null for it and a low confidence.",
      "Return strict JSON with exactly this shape:",
      "{",
      `  "detectedType": string, // the best match from this list: ${CREDENTIAL_TYPES.join(", ")} — use "custom" when none fits`,
      '  "holderName": string|null, // credential holder name in Latin letters as printed',
      '  "holderNameAr": string|null, // holder name in Arabic script as printed',
      '  "issuerName": string|null, // issuing organization in English/Latin',
      '  "issuerNameAr": string|null, // issuing organization in Arabic',
      '  "certificateNumber": string|null, // certificate / license / document number',
      '  "issueDate": string|null, // YYYY-MM-DD Gregorian; convert to Gregorian if only Hijri is printed',
      '  "expiryDate": string|null, // YYYY-MM-DD Gregorian',
      '  "confidence": { "overall": number, "type": number, "name": number, "issuer": number, "certNumber": number, "issueDate": number, "expiryDate": number } // each 0..1 for how clearly that field is readable; 0 for null fields',
      "}",
    ].join("\n");

    const response = await getAi().models.generateContent({
      model: OCR_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: buffer.toString("base64") } },
            { text: prompt },
          ],
        },
      ],
      config: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    });

    const raw = JSON.parse(response.text ?? "{}") as Record<string, unknown>;
    const rawConf = (raw.confidence ?? {}) as Record<string, unknown>;
    const clamp = (key: string): number => {
      const n = Number(rawConf[key]);
      return Number.isFinite(n)
        ? Math.min(1, Math.max(0, Math.round(n * 100) / 100))
        : 0;
    };
    const detectedType: CredentialType = (
      CREDENTIAL_TYPES as readonly string[]
    ).includes(String(raw.detectedType))
      ? (String(raw.detectedType) as CredentialType)
      : "custom";

    res.json({
      detectedType,
      holderName: ocrString(raw.holderName),
      holderNameAr: ocrString(raw.holderNameAr),
      issuerName: ocrString(raw.issuerName),
      issuerNameAr: ocrString(raw.issuerNameAr),
      certificateNumber: ocrString(raw.certificateNumber),
      issueDate: ocrDate(raw.issueDate),
      expiryDate: ocrDate(raw.expiryDate),
      confidence: {
        overall: clamp("overall"),
        type: clamp("type"),
        name: clamp("name"),
        issuer: clamp("issuer"),
        certNumber: clamp("certNumber"),
        issueDate: clamp("issueDate"),
        expiryDate: clamp("expiryDate"),
      },
    });
  } catch (error) {
    req.log.error({ err: error }, "OCR: AI extraction failed");
    res.status(502).json({ message: "AI document reading failed" });
  }
});

router.post("/credentials/check-duplicate", async (req, res) => {
  const { employeeId, type, certificateNumber } = req.body as {
    employeeId?: number;
    type?: string;
    certificateNumber?: string;
  };
  if (!employeeId || !type || !certificateNumber) {
    res.json({ isDuplicate: false });
    return;
  }
  // Scope check: caller may only probe employees they are authorized to see.
  const user = getUser(req);
  const scopedUsers = await getScopedUsers(user);
  if (!scopedUsers.some((u) => u.id === employeeId)) {
    res.status(403).json({ message: "Not authorized for this employee" });
    return;
  }
  const rows = await db
    .select()
    .from(credentialsTable)
    .where(eq(credentialsTable.employeeId, employeeId));
  const existing = rows.find(
    (c) =>
      c.type === type &&
      c.certificateNumber.trim().toLowerCase() ===
        certificateNumber.trim().toLowerCase(),
  );
  if (!existing) {
    res.json({ isDuplicate: false });
    return;
  }
  res.json({ isDuplicate: true, existingCredential: serializeCredential(existing) });
});

// ---------------------------------------------------------------------------
// List / create
// ---------------------------------------------------------------------------

router.get("/credentials", async (req, res) => {
  const user = getUser(req);
  const scoped = await getScopedUsers(user);
  const byId = new Map(scoped.map((u) => [u.id, u]));
  let creds = await getCredentialsFor(scoped.map((u) => u.id));

  const { status, type, employeeId, departmentId, search } = req.query as Record<
    string,
    string | undefined
  >;
  if (employeeId) creds = creds.filter((c) => c.employeeId === Number(employeeId));
  if (departmentId) {
    const deptIds = new Set(
      scoped
        .filter((u) => u.departmentId === Number(departmentId))
        .map((u) => u.id),
    );
    creds = creds.filter((c) => deptIds.has(c.employeeId));
  }
  if (type) creds = creds.filter((c) => c.type === type);
  if (status) creds = creds.filter((c) => computeStatus(c.expiryDate) === status);
  if (search) {
    const q = search.toLowerCase();
    creds = creds.filter((c) => {
      const emp = byId.get(c.employeeId);
      return (
        c.holderName.toLowerCase().includes(q) ||
        c.holderNameAr.includes(search) ||
        c.certificateNumber.toLowerCase().includes(q) ||
        c.issuerName.toLowerCase().includes(q) ||
        c.issuerNameAr.includes(search) ||
        (emp?.name.toLowerCase().includes(q) ?? false) ||
        (emp?.nameAr.includes(search) ?? false)
      );
    });
  }

  creds.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
  const total = creds.length;
  const slice = creds.slice((page - 1) * pageSize, page * pageSize);
  res.json({
    data: slice.map((c) => serializeCredential(c, byId.get(c.employeeId))),
    total,
    page,
    pageSize,
  });
});

router.post("/credentials", async (req, res) => {
  const user = getUser(req);
  const body = req.body as Record<string, unknown>;
  const requiredFields = [
    "type",
    "holderName",
    "holderNameAr",
    "issuerName",
    "issuerNameAr",
    "certificateNumber",
    "issueDate",
    "expiryDate",
  ];
  for (const f of requiredFields) {
    if (!body[f] || typeof body[f] !== "string") {
      res.status(400).json({ message: `Missing required field: ${f}` });
      return;
    }
  }
  const type = body.type as string;
  if (!CREDENTIAL_TYPES.includes(type as CredentialType)) {
    res.status(400).json({ message: `Invalid credential type: ${type}` });
    return;
  }
  const issueDate = normalizeCalendarDate(body.issueDate as string);
  const expiryDate = normalizeCalendarDate(body.expiryDate as string);
  if (!issueDate || !expiryDate || issueDate > expiryDate) {
    res.status(400).json({
      message: "Valid issue and expiry dates are required, and expiry must not precede issue",
    });
    return;
  }

  let employeeId = Number(body.employeeId ?? user.id);
  if (user.role === "employee") employeeId = user.id;
  const scoped = await getScopedUsers(user);
  const employee = scoped.find((u) => u.id === employeeId);
  if (!employee) {
    res.status(403).json({ message: "Employee not in your scope" });
    return;
  }

  let fileUrl =
    typeof body.fileUrl === "string" && body.fileUrl ? body.fileUrl : null;
  if (fileUrl) {
    const finalized = await finalizeStoredFileUrl(fileUrl, employeeId, user.id);
    if (!finalized) {
      res.status(400).json({
        message: "Credential files must be uploaded to object storage first",
      });
      return;
    }
    fileUrl = finalized;
  }

  const inserted = await db
    .insert(credentialsTable)
    .values({
      employeeId,
      type: type as CredentialType,
      customTypeName: (body.customTypeName as string) ?? null,
      customTypeNameAr: (body.customTypeNameAr as string) ?? null,
      holderName: body.holderName as string,
      holderNameAr: body.holderNameAr as string,
      issuerName: body.issuerName as string,
      issuerNameAr: body.issuerNameAr as string,
      certificateNumber: body.certificateNumber as string,
      issueDate,
      expiryDate,
      fileUrl,
      fileType: (body.fileType as string) ?? null,
      qrToken: crypto.randomBytes(16).toString("hex"),
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
      notes: (body.notes as string) ?? null,
      confidence: typeof body.confidence === "number" ? body.confidence : null,
      isVerified: false,
    })
    .returning();
  const cred = inserted[0];
  if (!cred) {
    res.status(500).json({ message: "Insert failed" });
    return;
  }

  await logAudit(
    user,
    "Added credential",
    "إضافة وثيقة",
    `${cred.type} · ${cred.certificateNumber}`,
    `${cred.type} · ${cred.certificateNumber}`,
    undefined,
    req.ip,
  );
  await db.insert(notificationsTable).values({
    userId: employeeId,
    type: "new_credential",
    titleAr: "وثيقة جديدة",
    titleEn: "New credential",
    messageAr: `تمت إضافة وثيقة «${cred.customTypeNameAr ?? cred.type}» إلى ملفك`,
    messageEn: `A ${cred.customTypeName ?? cred.type} credential was added to your profile`,
    credentialId: cred.id,
    employeeId,
    isRead: false,
    daysUntilExpiry: daysUntil(cred.expiryDate),
  });

  res.status(201).json(serializeCredential(cred, employee));
});

// ---------------------------------------------------------------------------
// Detail / update / delete
// ---------------------------------------------------------------------------

async function findScopedCredential(
  req: Parameters<typeof getUser>[0],
): Promise<{ cred: typeof credentialsTable.$inferSelect; owner: User } | null> {
  const user = getUser(req);
  const id = Number((req.params as Record<string, string>).id);
  if (!Number.isFinite(id)) return null;
  const rows = await db
    .select()
    .from(credentialsTable)
    .where(eq(credentialsTable.id, id));
  const cred = rows[0];
  if (!cred) return null;
  const scoped = await getScopedUsers(user);
  const owner = scoped.find((u) => u.id === cred.employeeId);
  if (!owner) return null;
  return { cred, owner };
}

router.get("/credentials/:id", async (req, res) => {
  const found = await findScopedCredential(req);
  if (!found) {
    res.status(404).json({ message: "Credential not found" });
    return;
  }
  res.json(serializeCredential(found.cred, found.owner));
});

router.patch("/credentials/:id", async (req, res) => {
  const user = getUser(req);
  const found = await findScopedCredential(req);
  if (!found) {
    res.status(404).json({ message: "Credential not found" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const stringFields = [
    "customTypeName",
    "customTypeNameAr",
    "holderName",
    "holderNameAr",
    "issuerName",
    "issuerNameAr",
    "certificateNumber",
    "notes",
    "fileUrl",
    "fileType",
  ];
  for (const f of stringFields) {
    if (f in body) patch[f] = body[f] as string | null;
  }
  if (typeof body.type === "string" && CREDENTIAL_TYPES.includes(body.type as CredentialType)) {
    patch.type = body.type;
  }
  const nextIssueDate =
    typeof body.issueDate === "string"
      ? normalizeCalendarDate(body.issueDate)
      : found.cred.issueDate;
  const nextExpiryDate =
    typeof body.expiryDate === "string"
      ? normalizeCalendarDate(body.expiryDate)
      : found.cred.expiryDate;
  if (!nextIssueDate || !nextExpiryDate || nextIssueDate > nextExpiryDate) {
    res.status(400).json({
      message: "Valid issue and expiry dates are required, and expiry must not precede issue",
    });
    return;
  }
  if (typeof body.issueDate === "string") patch.issueDate = nextIssueDate;
  if (typeof body.expiryDate === "string") patch.expiryDate = nextExpiryDate;
  if (Array.isArray(body.tags)) patch.tags = body.tags;
  if (typeof body.isVerified === "boolean") {
    if (
      !MANAGER_ROLES.includes(user.role) ||
      found.cred.employeeId === user.id
    ) {
      res.status(403).json({ message: "Credentials cannot be self-verified" });
      return;
    }
    patch.isVerified = body.isVerified;
  }

  // Normalize "remove the file" to null, then require any provided file to
  // be a real object-storage path — data: URLs can no longer be persisted.
  if (patch.fileUrl === "") patch.fileUrl = null;
  if (typeof patch.fileUrl === "string" && patch.fileUrl) {
    const finalized = await finalizeStoredFileUrl(
      patch.fileUrl,
      found.cred.employeeId,
      user.id,
    );
    if (!finalized) {
      res.status(400).json({
        message: "Credential files must be uploaded to object storage first",
      });
      return;
    }
    patch.fileUrl = finalized;
  }

  const updated = await db
    .update(credentialsTable)
    .set(patch)
    .where(eq(credentialsTable.id, found.cred.id))
    .returning();
  const cred = updated[0];
  if (!cred) {
    res.status(500).json({ message: "Update failed" });
    return;
  }
  await logAudit(
    user,
    "Updated credential",
    "تحديث وثيقة",
    `${cred.type} · ${cred.certificateNumber}`,
    `${cred.type} · ${cred.certificateNumber}`,
    undefined,
    req.ip,
  );
  res.json(serializeCredential(cred, found.owner));
});

router.delete("/credentials/:id", async (req, res) => {
  const user = getUser(req);
  const found = await findScopedCredential(req);
  if (!found) {
    res.status(404).json({ message: "Credential not found" });
    return;
  }
  await db
    .delete(notificationsTable)
    .where(eq(notificationsTable.credentialId, found.cred.id));
  await db.delete(credentialsTable).where(eq(credentialsTable.id, found.cred.id));
  await logAudit(
    user,
    "Deleted credential",
    "حذف وثيقة",
    `${found.cred.type} · ${found.cred.certificateNumber}`,
    `${found.cred.type} · ${found.cred.certificateNumber}`,
    undefined,
    req.ip,
  );
  res.status(204).end();
});

export default router;
