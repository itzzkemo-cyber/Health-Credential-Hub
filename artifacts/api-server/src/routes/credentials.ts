import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import {
  db,
  credentialsTable,
  usersTable,
  notificationsTable,
  auditLogsTable,
  uploadGrantsTable,
  CREDENTIAL_TYPES,
  type CredentialType,
  type User,
} from "@workspace/db";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
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
  evaluateCredentialVerificationChange,
  isUserInScope,
  logAudit,
} from "../lib/helpers";
import {
  getObjectAclPolicy,
  setObjectAclPolicy,
  ObjectPermission,
} from "../lib/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import {
  ALLOWED_UPLOAD_CONTENT_TYPE,
  MAX_UPLOAD_BYTES,
  findActiveUploadGrant,
  validateUploadedObject,
} from "../lib/uploadSecurity";
import { getAi } from "@workspace/integrations-gemini-ai";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

class InvalidCredentialFileError extends Error {}

function normalizeCalendarDate(value: string): string | null {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

async function canAccessLinkedObject(
  user: User,
  fileUrl: string,
): Promise<boolean> {
  const linked = await db
    .select({ employeeId: credentialsTable.employeeId })
    .from(credentialsTable)
    .where(
      and(
        eq(credentialsTable.fileUrl, fileUrl),
        isNull(credentialsTable.deletedAt),
      ),
    );
  if (linked.length === 0) return false;
  if (linked.some((entry) => entry.employeeId === user.id)) return true;
  if (!MANAGER_ROLES.includes(user.role)) return false;
  const scopedIds = new Set(
    (await getScopedUsers(user)).map((entry) => entry.id),
  );
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
    .where(
      and(
        eq(credentialsTable.qrToken, token),
        isNull(credentialsTable.deletedAt),
      ),
    );
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
  const policies = await getPolicies(
    user.role === "system_admin" ? null : user.facilityId,
  );
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
// AI document reading (OCR) — optional Gemini vision integration
// ---------------------------------------------------------------------------

const OCR_MODEL = "gemini-2.5-flash";
// The integration accepts inline input data, capped at 8 MB.
const MAX_OCR_BYTES = MAX_UPLOAD_BYTES;
// Same explicit allowlist as the upload presign policy in storage.ts.
const OCR_MIME_ALLOWLIST = ALLOWED_UPLOAD_CONTENT_TYPE;

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
    res
      .status(429)
      .json({ message: "Too many AI reading requests, try again later" });
    return;
  }

  // Load the uploaded document from object storage.
  let buffer: Buffer;
  let mimeType: string;
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(fileUrl);
    const pendingGrant = await findActiveUploadGrant(fileUrl, user.id);

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
      const canAccessLinked = await canAccessLinkedObject(user, fileUrl);
      // ACL ownership alone is insufficient after the upload grant has been
      // consumed: the object must still belong to an active credential. This
      // keeps retained soft-deleted evidence inaccessible to OCR callers.
      if (!(isOwner && pendingGrant) && !canAccessLinked) {
        res.status(403).json({ message: "Forbidden" });
        return;
      }
    } else if (!pendingGrant) {
      res.status(403).json({
        message: "Upload grant expired or does not belong to this user",
      });
      return;
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

    const metadata = await validateUploadedObject(objectFile, pendingGrant);
    mimeType = metadata.contentType;
    if (!OCR_MIME_ALLOWLIST.test(mimeType)) {
      res.status(422).json({ message: "Unsupported document type" });
      return;
    }
    if (metadata.size > MAX_OCR_BYTES) {
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
    req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "OCR: failed to load stored document",
    );
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

    const extracted = {
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
    };
    await logAudit(
      user,
      "Used AI credential extraction",
      "استخدام الاستخراج الذكي للوثائق",
      "Credential document",
      "وثيقة اعتماد",
      undefined,
      req.ip,
    );
    res.json(extracted);
  } catch (error) {
    // SDK errors are deliberately not serialized: provider request objects can
    // contain the inline Base64 document or authorization metadata.
    req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "OCR: AI extraction failed",
    );
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
    .where(
      and(
        eq(credentialsTable.employeeId, employeeId),
        isNull(credentialsTable.deletedAt),
      ),
    );
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
  res.json({
    isDuplicate: true,
    existingCredential: serializeCredential(existing),
  });
});

// ---------------------------------------------------------------------------
// List / create
// ---------------------------------------------------------------------------

router.get("/credentials", async (req, res) => {
  const user = getUser(req);
  const scoped = await getScopedUsers(user);
  const byId = new Map(scoped.map((u) => [u.id, u]));
  let creds = await getCredentialsFor(scoped.map((u) => u.id));

  const { status, type, employeeId, departmentId, search } =
    req.query as Record<string, string | undefined>;
  if (employeeId)
    creds = creds.filter((c) => c.employeeId === Number(employeeId));
  if (departmentId) {
    const deptIds = new Set(
      scoped
        .filter((u) => u.departmentId === Number(departmentId))
        .map((u) => u.id),
    );
    creds = creds.filter((c) => deptIds.has(c.employeeId));
  }
  if (type) creds = creds.filter((c) => c.type === type);
  if (status)
    creds = creds.filter((c) => computeStatus(c.expiryDate) === status);
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
      message:
        "Valid issue and expiry dates are required, and expiry must not precede issue",
    });
    return;
  }

  const requestedEmployeeId = Number(body.employeeId ?? user.id);
  if (!Number.isSafeInteger(requestedEmployeeId) || requestedEmployeeId < 1) {
    res.status(400).json({ message: "A valid employeeId is required" });
    return;
  }
  const requestedFileUrl =
    typeof body.fileUrl === "string" && body.fileUrl ? body.fileUrl : null;

  let transactionResult;
  try {
    transactionResult = await db.transaction(async (tx) => {
      // Lock the current database actor and candidate owner together. A role
      // change to employee forces self-ownership even if the request carried a
      // different employeeId from an earlier, more privileged UI state.
      const lockedUsers = await tx
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, [user.id, requestedEmployeeId]))
        .orderBy(usersTable.id)
        .for("update");
      const actor = lockedUsers.find((entry) => entry.id === user.id);
      if (!actor || !actor.isActive) return { kind: "forbidden" as const };
      const effectiveEmployeeId =
        actor.role === "employee" ? actor.id : requestedEmployeeId;
      const employee = lockedUsers.find(
        (entry) => entry.id === effectiveEmployeeId,
      );
      if (!employee || !isUserInScope(actor, employee)) {
        return { kind: "forbidden" as const };
      }

      let fileUrl: string | null = null;
      if (requestedFileUrl) {
        if (!requestedFileUrl.startsWith("/objects/")) {
          throw new InvalidCredentialFileError();
        }
        const grant = (
          await tx
            .select()
            .from(uploadGrantsTable)
            .where(
              and(
                eq(uploadGrantsTable.objectPath, requestedFileUrl),
                eq(uploadGrantsTable.requestedBy, actor.id),
                isNull(uploadGrantsTable.claimedAt),
                gt(uploadGrantsTable.expiresAt, new Date()),
              ),
            )
            .for("update")
        )[0];
        if (!grant) throw new InvalidCredentialFileError();

        try {
          const objectFile =
            await objectStorageService.getObjectEntityFile(requestedFileUrl);
          const existingPolicy = await getObjectAclPolicy(objectFile);
          if (
            existingPolicy &&
            existingPolicy.owner !== String(actor.id) &&
            existingPolicy.owner !== String(employee.id)
          ) {
            throw new InvalidCredentialFileError();
          }
          await validateUploadedObject(objectFile, grant);
          const consumed = await tx
            .update(uploadGrantsTable)
            .set({ claimedAt: new Date() })
            .where(
              and(
                eq(uploadGrantsTable.id, grant.id),
                isNull(uploadGrantsTable.claimedAt),
                gt(uploadGrantsTable.expiresAt, new Date()),
              ),
            )
            .returning({ id: uploadGrantsTable.id });
          if (!consumed[0]) throw new InvalidCredentialFileError();
          fileUrl = await objectStorageService.trySetObjectEntityAclPolicy(
            requestedFileUrl,
            {
              owner: String(employee.id),
              visibility: "private",
            },
          );
        } catch (error) {
          if (error instanceof InvalidCredentialFileError) throw error;
          throw new InvalidCredentialFileError();
        }
      }

      const cred = (
        await tx
          .insert(credentialsTable)
          .values({
            employeeId: employee.id,
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
            confidence:
              typeof body.confidence === "number" ? body.confidence : null,
            isVerified: false,
          })
          .returning()
      )[0];
      if (!cred) throw new Error("Credential insert returned no row");

      await tx.insert(auditLogsTable).values({
        userId: actor.id,
        userName: actor.name,
        userNameAr: actor.nameAr,
        action: "Added credential",
        actionAr: "إضافة وثيقة",
        target: `${cred.type} · ${cred.certificateNumber}`,
        targetAr: `${cred.type} · ${cred.certificateNumber}`,
        details: null,
        ipAddress: req.ip ?? null,
      });
      await tx.insert(notificationsTable).values({
        userId: employee.id,
        type: "new_credential",
        titleAr: "وثيقة جديدة",
        titleEn: "New credential",
        messageAr: `تمت إضافة وثيقة «${cred.customTypeNameAr ?? cred.type}» إلى ملفك`,
        messageEn: `A ${cred.customTypeName ?? cred.type} credential was added to your profile`,
        credentialId: cred.id,
        employeeId: employee.id,
        isRead: false,
        daysUntilExpiry: daysUntil(cred.expiryDate),
      });
      return { kind: "created" as const, cred, employee };
    });
  } catch (error) {
    if (error instanceof InvalidCredentialFileError) {
      res.status(400).json({
        message: "Credential files must be uploaded to object storage first",
      });
      return;
    }
    throw error;
  }

  if (transactionResult.kind === "forbidden") {
    res.status(403).json({ message: "Employee not in your scope" });
    return;
  }
  res
    .status(201)
    .json(
      serializeCredential(transactionResult.cred, transactionResult.employee),
    );
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
    .where(
      and(eq(credentialsTable.id, id), isNull(credentialsTable.deletedAt)),
    );
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
  if (
    !Number.isSafeInteger(body.expectedVersion) ||
    Number(body.expectedVersion) < 1
  ) {
    res.status(428).json({
      message: "expectedVersion is required for credential updates",
    });
    return;
  }
  const expectedVersion = Number(body.expectedVersion);
  if (expectedVersion !== found.cred.rowVersion) {
    res.status(409).json({
      message: "Credential changed — reload it before updating",
    });
    return;
  }
  const patch: Record<string, unknown> = {
    updatedAt: new Date(),
    rowVersion: sql`${credentialsTable.rowVersion} + 1`,
  };
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
  if (
    typeof body.type === "string" &&
    CREDENTIAL_TYPES.includes(body.type as CredentialType)
  ) {
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
      message:
        "Valid issue and expiry dates are required, and expiry must not precede issue",
    });
    return;
  }
  if (typeof body.issueDate === "string") patch.issueDate = nextIssueDate;
  if (typeof body.expiryDate === "string") patch.expiryDate = nextExpiryDate;
  if (Array.isArray(body.tags)) patch.tags = body.tags;

  // Normalize file removal before comparing evidence. Re-sending the current
  // path is a no-op and must not require a second, already-consumed grant.
  if (
    Object.prototype.hasOwnProperty.call(body, "fileUrl") &&
    body.fileUrl !== null &&
    typeof body.fileUrl !== "string"
  ) {
    res
      .status(400)
      .json({ message: "Credential file path must be a string or null" });
    return;
  }
  if (patch.fileUrl === "") patch.fileUrl = null;
  const fileChanged =
    Object.prototype.hasOwnProperty.call(patch, "fileUrl") &&
    patch.fileUrl !== found.cred.fileUrl;
  if (!fileChanged) delete patch.fileUrl;

  const verificationChange = evaluateCredentialVerificationChange(
    found.cred,
    patch,
    typeof body.isVerified === "boolean" ? body.isVerified : undefined,
  );
  if (typeof body.isVerified === "boolean") {
    if (
      !MANAGER_ROLES.includes(user.role) ||
      found.cred.employeeId === user.id
    ) {
      res.status(403).json({ message: "Credentials cannot be self-verified" });
      return;
    }
    if (verificationChange.conflictsWithVerification) {
      res.status(400).json({
        message: "Verify the credential only after saving material changes",
      });
      return;
    }
  }

  if (verificationChange.nextVerification !== undefined) {
    patch.isVerified = verificationChange.nextVerification;
  }

  let transactionResult;
  try {
    transactionResult = await db.transaction(async (tx) => {
      // Lock both the credential evidence and the current actor/owner scope.
      // This prevents role, facility, department, or supervisor changes from
      // racing the final write after the preliminary UX-friendly lookup.
      const current = (
        await tx
          .select()
          .from(credentialsTable)
          .where(
            and(
              eq(credentialsTable.id, found.cred.id),
              isNull(credentialsTable.deletedAt),
              eq(credentialsTable.rowVersion, expectedVersion),
            ),
          )
          .for("update")
      )[0];
      if (!current) return { kind: "conflict" as const };

      const lockedUsers = await tx
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, [user.id, current.employeeId]))
        .orderBy(usersTable.id)
        .for("update");
      const actor = lockedUsers.find((entry) => entry.id === user.id);
      const owner = lockedUsers.find(
        (entry) => entry.id === current.employeeId,
      );
      if (!actor || !owner || !isUserInScope(actor, owner)) {
        return { kind: "forbidden" as const };
      }
      if (
        typeof body.isVerified === "boolean" &&
        (!MANAGER_ROLES.includes(actor.role) || current.employeeId === actor.id)
      ) {
        return { kind: "forbidden" as const };
      }

      const transactionPatch = { ...patch };
      // A changed file is finalized only after the record and scope are
      // locked. Grant consumption rolls back with the DB transaction if GCS
      // validation/ACL or the credential update fails.
      if (
        typeof transactionPatch.fileUrl === "string" &&
        transactionPatch.fileUrl
      ) {
        const rawUrl = transactionPatch.fileUrl;
        if (!rawUrl.startsWith("/objects/")) {
          throw new InvalidCredentialFileError();
        }
        const grant = (
          await tx
            .select()
            .from(uploadGrantsTable)
            .where(
              and(
                eq(uploadGrantsTable.objectPath, rawUrl),
                eq(uploadGrantsTable.requestedBy, actor.id),
                isNull(uploadGrantsTable.claimedAt),
                gt(uploadGrantsTable.expiresAt, new Date()),
              ),
            )
            .for("update")
        )[0];
        if (!grant) throw new InvalidCredentialFileError();

        let normalized: string;
        try {
          const objectFile =
            await objectStorageService.getObjectEntityFile(rawUrl);
          const existingPolicy = await getObjectAclPolicy(objectFile);
          if (
            existingPolicy &&
            existingPolicy.owner !== String(actor.id) &&
            existingPolicy.owner !== String(owner.id)
          ) {
            throw new InvalidCredentialFileError();
          }
          await validateUploadedObject(objectFile, grant);
          const consumed = await tx
            .update(uploadGrantsTable)
            .set({ claimedAt: new Date() })
            .where(
              and(
                eq(uploadGrantsTable.id, grant.id),
                isNull(uploadGrantsTable.claimedAt),
                gt(uploadGrantsTable.expiresAt, new Date()),
              ),
            )
            .returning({ id: uploadGrantsTable.id });
          if (!consumed[0]) throw new InvalidCredentialFileError();
          normalized = await objectStorageService.trySetObjectEntityAclPolicy(
            rawUrl,
            {
              owner: String(owner.id),
              visibility: "private",
            },
          );
        } catch (error) {
          if (error instanceof InvalidCredentialFileError) throw error;
          throw new InvalidCredentialFileError();
        }
        transactionPatch.fileUrl = normalized;
      }

      const cred = (
        await tx
          .update(credentialsTable)
          .set(transactionPatch)
          .where(
            and(
              eq(credentialsTable.id, current.id),
              isNull(credentialsTable.deletedAt),
              eq(credentialsTable.rowVersion, expectedVersion),
            ),
          )
          .returning()
      )[0];
      if (!cred) return { kind: "conflict" as const };

      const verificationChanged = cred.isVerified !== current.isVerified;
      const auditAction: [string, string] = verificationChanged
        ? cred.isVerified
          ? ["Verified credential", "توثيق وثيقة"]
          : ["Unverified credential", "إلغاء توثيق وثيقة"]
        : ["Updated credential", "تحديث وثيقة"];
      await tx.insert(auditLogsTable).values({
        userId: actor.id,
        userName: actor.name,
        userNameAr: actor.nameAr,
        action: auditAction[0],
        actionAr: auditAction[1],
        target: `${cred.type} · ${cred.certificateNumber}`,
        targetAr: `${cred.type} · ${cred.certificateNumber}`,
        details: null,
        ipAddress: req.ip ?? null,
      });
      return { kind: "updated" as const, cred, owner };
    });
  } catch (error) {
    if (error instanceof InvalidCredentialFileError) {
      res.status(400).json({
        message: "Credential files must be uploaded to object storage first",
      });
      return;
    }
    throw error;
  }

  if (transactionResult.kind === "forbidden") {
    res.status(404).json({ message: "Credential not found" });
    return;
  }
  if (transactionResult.kind === "conflict") {
    res.status(409).json({
      message: "Credential changed — reload it and try again",
    });
    return;
  }
  res.json(
    serializeCredential(transactionResult.cred, transactionResult.owner),
  );
});

router.delete("/credentials/:id", async (req, res) => {
  const user = getUser(req);
  const found = await findScopedCredential(req);
  if (!found) {
    res.status(404).json({ message: "Credential not found" });
    return;
  }
  const deleted = await db.transaction(async (tx) => {
    const current = (
      await tx
        .select()
        .from(credentialsTable)
        .where(
          and(
            eq(credentialsTable.id, found.cred.id),
            isNull(credentialsTable.deletedAt),
          ),
        )
        .for("update")
    )[0];
    if (!current) return false;

    const lockedUsers = await tx
      .select()
      .from(usersTable)
      .where(inArray(usersTable.id, [user.id, current.employeeId]))
      .orderBy(usersTable.id)
      .for("update");
    const actor = lockedUsers.find((entry) => entry.id === user.id);
    const owner = lockedUsers.find((entry) => entry.id === current.employeeId);
    if (!actor || !owner || !isUserInScope(actor, owner)) {
      return false;
    }

    const rows = await tx
      .update(credentialsTable)
      .set({
        deletedAt: new Date(),
        deletedBy: actor.id,
        updatedAt: new Date(),
        rowVersion: sql`${credentialsTable.rowVersion} + 1`,
      })
      .where(
        and(
          eq(credentialsTable.id, current.id),
          isNull(credentialsTable.deletedAt),
          eq(credentialsTable.rowVersion, current.rowVersion),
        ),
      )
      .returning({ id: credentialsTable.id });
    if (!rows[0]) return false;

    await tx
      .delete(notificationsTable)
      .where(eq(notificationsTable.credentialId, current.id));
    await tx.insert(auditLogsTable).values({
      userId: actor.id,
      userName: actor.name,
      userNameAr: actor.nameAr,
      action: "Deleted credential",
      actionAr: "حذف وثيقة",
      target: `${current.type} · ${current.certificateNumber}`,
      targetAr: `${current.type} · ${current.certificateNumber}`,
      details:
        "Credential record and private object retained for the configured retention and cleanup process",
      ipAddress: req.ip ?? null,
    });
    return true;
  });
  if (!deleted) {
    res.status(404).json({ message: "Credential not found" });
    return;
  }
  res.status(204).end();
});

export default router;
