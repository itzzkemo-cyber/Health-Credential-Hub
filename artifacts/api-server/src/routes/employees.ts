import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  db,
  usersTable,
  credentialsTable,
  facilitiesTable,
  departmentsTable,
  auditLogsTable,
  employeeInvitationsTable,
  USER_ROLES,
  type User,
} from "@workspace/db";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  requireAuth,
  requireRole,
  getUser,
  hashPassword,
  comparePassword,
  MANAGER_ROLES,
  ADMIN_ROLES,
} from "../lib/auth";
import { consumeSecondFactor } from "../lib/secondFactor";
import { isProtectedMfaUser } from "../lib/protectedMfa";
import { isFreshActiveSessionActor } from "../lib/sessionFreshness";
import { rateLimit } from "../lib/rateLimit";
import {
  hasAllowedPasswordInputLength,
  hasAllowedPasswordLength,
} from "../lib/passwordPolicy";
import {
  createEmailIdempotencyKey,
  isEmailConfigured,
  sendEmail,
} from "../lib/email/sender";
import {
  employeeInvitationEmail,
  employeeInvitationText,
  getEmployeeInvitationUrl,
} from "../lib/email/templates";
import { logger } from "../lib/logger";
import {
  getCredentialScopedUsers,
  getCredentialsFor,
  getPolicies,
  computeEmployeeStats,
  serializeUser,
  serializeCredential,
  employeeSummary,
  getDepartments,
} from "../lib/helpers";
import {
  canAssignRole,
  canManageTarget,
  canSuperviseTarget,
  isUserInScope,
} from "../lib/roleHierarchy";

const router: IRouter = Router();
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function isPostgresUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}

const ACCOUNT_AUDIT_FIELDS = [
  "role",
  "departmentId",
  "supervisorId",
  "isActive",
] as const;

// This is an authenticated, single-instance safety net for repeated password
// and second-factor guesses across every employee account-state endpoint. The
// shared name makes PATCH, DELETE, activate, and deactivate consume one budget
// per source IP instead of granting a separate brute-force budget per route.
const employeeStepUpRateLimit = rateLimit({
  name: "employee-step-up",
  max: 10,
  windowMs: 10 * 60_000,
});

const EMPLOYEE_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredTrimmedString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | null {
  const value = body[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

async function verifyAdministrativeStepUp(
  tx: Transaction,
  actor: User,
  currentPassword: string | null,
  code: string | null,
): Promise<"verified" | "admin_mfa_required" | "step_up_failed"> {
  const protectedAccount = isProtectedMfaUser(actor);
  if (protectedAccount && (!actor.totpEnabled || !actor.totpSecret)) {
    return "admin_mfa_required";
  }
  if (
    !currentPassword ||
    !(await comparePassword(currentPassword, actor.passwordHash))
  ) {
    return "step_up_failed";
  }
  if (!protectedAccount) return "verified";
  const steppedUp = code ? await consumeSecondFactor(tx, actor, code) : null;
  return steppedUp ? "verified" : "step_up_failed";
}

function rateLimitOrganizationalPatch(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  if (
    ACCOUNT_AUDIT_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(body, field),
    )
  ) {
    employeeStepUpRateLimit(req, res, next);
    return;
  }
  next();
}

function accountChangeDetails(before: User, after: User): string | null {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of ACCOUNT_AUDIT_FIELDS) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return Object.keys(changes).length > 0 ? JSON.stringify(changes) : null;
}

router.use("/employees", requireAuth);

router.get("/employees", async (req, res) => {
  const user = getUser(req);
  // Directory visibility follows the same strict hierarchy as credential
  // access: self plus lower-ranked managed users. A hospital administrator
  // must not discover a peer administrator or a system administrator merely
  // because they share a facility.
  let scoped = await getCredentialScopedUsers(user);

  const {
    facilityId,
    departmentId,
    supervisorId,
    role,
    isActive,
    search,
    atRisk,
  } = req.query as Record<string, string | undefined>;
  if (facilityId && user.role === "system_admin") {
    scoped = scoped.filter((u) => u.facilityId === Number(facilityId));
  }
  if (departmentId)
    scoped = scoped.filter((u) => u.departmentId === Number(departmentId));
  if (supervisorId)
    scoped = scoped.filter((u) => u.supervisorId === Number(supervisorId));
  if (role) scoped = scoped.filter((u) => u.role === role);
  if (isActive !== undefined) {
    scoped = scoped.filter((u) => u.isActive === (isActive === "true"));
  }
  if (search) {
    const q = search.toLowerCase();
    scoped = scoped.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.nameAr.includes(search) ||
        u.email.toLowerCase().includes(q) ||
        u.employeeNumber.toLowerCase().includes(q),
    );
  }

  const creds = await getCredentialsFor(scoped.map((u) => u.id));
  const policies = await getPolicies(
    user.role === "system_admin" ? null : user.facilityId,
  );
  const departments = await getDepartments(
    user.role === "system_admin" ? null : user.facilityId,
  );
  const deptById = new Map(departments.map((d) => [d.id, d]));

  let result = scoped.map((u) => {
    const stats = computeEmployeeStats(u, creds, policies);
    const dept =
      u.departmentId != null ? deptById.get(u.departmentId) : undefined;
    return {
      ...serializeUser(u),
      ...(dept
        ? { department: { id: dept.id, name: dept.name, nameAr: dept.nameAr } }
        : {}),
      complianceRate: stats.complianceRate,
      totalCredentials: stats.totalCredentials,
      expiredCount: stats.expiredCount,
      expiringCount: stats.expiringCount,
      missingCount: stats.missingCount,
      isAtRisk: stats.isAtRisk,
    };
  });
  if (atRisk !== undefined) {
    result = result.filter((r) => r.isAtRisk === (atRisk === "true"));
  }
  result.sort((a, b) => a.complianceRate - b.complianceRate);
  res.json(result);
});

router.post(
  "/employees",
  requireRole(...ADMIN_ROLES),
  employeeStepUpRateLimit,
  async (req, res) => {
    const requestUser = getUser(req);
    const body = req.body as Record<string, unknown>;
    const currentPassword = hasAllowedPasswordInputLength(body.currentPassword)
      ? body.currentPassword
      : "";
    const stepUpCode = requiredTrimmedString(body, "code", 128) ?? "";
    const required = [
      "name",
      "nameAr",
      "email",
      "password",
      "role",
      "jobTitle",
      "jobTitleAr",
      "employeeNumber",
    ];
    for (const f of required) {
      if (!body[f] || typeof body[f] !== "string") {
        res.status(400).json({ message: `Missing required field: ${f}` });
        return;
      }
    }
    const role = body.role as string;
    if (!USER_ROLES.includes(role as User["role"])) {
      res.status(400).json({ message: `Invalid role: ${role}` });
      return;
    }
    const email = (body.email as string).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ message: "A valid email address is required" });
      return;
    }
    if (!hasAllowedPasswordLength(body.password)) {
      res.status(400).json({
        message: "Password must contain between 12 and 1024 characters",
      });
      return;
    }
    const requestedFacilityId =
      body.facilityId != null ? Number(body.facilityId) : null;
    const facilityInputIsValid =
      requestedFacilityId == null ||
      (Number.isInteger(requestedFacilityId) && requestedFacilityId > 0);
    const departmentId =
      body.departmentId != null ? Number(body.departmentId) : null;
    if (
      departmentId != null &&
      (!Number.isInteger(departmentId) || departmentId <= 0)
    ) {
      res
        .status(400)
        .json({ message: "departmentId must be a positive integer" });
      return;
    }
    const supervisorId =
      body.supervisorId != null ? Number(body.supervisorId) : null;
    if (
      supervisorId != null &&
      (!Number.isInteger(supervisorId) || supervisorId <= 0)
    ) {
      res
        .status(400)
        .json({ message: "supervisorId must be a positive integer" });
      return;
    }
    const passwordHash = await hashPassword(body.password as string);
    let result;
    try {
      result = await db.transaction(async (tx) => {
        // Department retirement locks the department before its members. Follow
        // the same global order so a department cannot be deleted between the
        // eligibility check and the employee insert.
        const department =
          departmentId == null
            ? null
            : (
                await tx
                  .select({
                    id: departmentsTable.id,
                    facilityId: departmentsTable.facilityId,
                  })
                  .from(departmentsTable)
                  .where(
                    and(
                      eq(departmentsTable.id, departmentId),
                      isNull(departmentsTable.deletedAt),
                    ),
                  )
                  .for("key share")
              )[0];

        const userIds = [
          requestUser.id,
          ...(supervisorId ? [supervisorId] : []),
        ]
          .filter((value, index, values) => values.indexOf(value) === index)
          .sort((left, right) => left - right);
        const lockedUsers = await tx
          .select()
          .from(usersTable)
          .where(inArray(usersTable.id, userIds))
          .orderBy(usersTable.id)
          .for("update");
        const actor = lockedUsers.find(
          (candidate) => candidate.id === requestUser.id,
        );
        if (!isFreshActiveSessionActor(actor, requestUser)) {
          return { kind: "unauthorized" as const };
        }
        if (!ADMIN_ROLES.includes(actor.role)) {
          return { kind: "forbidden" as const };
        }
        if (!canAssignRole(actor, role as User["role"])) {
          return { kind: "role_forbidden" as const };
        }

        const facilityId =
          actor.role === "system_admin" && requestedFacilityId != null
            ? requestedFacilityId
            : actor.facilityId;
        if (
          !Number.isInteger(facilityId) ||
          facilityId <= 0 ||
          (actor.role === "system_admin" && !facilityInputIsValid)
        ) {
          return { kind: "invalid_facility_id" as const };
        }
        const facility = await tx
          .select({ id: facilitiesTable.id })
          .from(facilitiesTable)
          .where(eq(facilitiesTable.id, facilityId));
        if (facility.length === 0) {
          return { kind: "facility_not_found" as const };
        }
        if (
          departmentId != null &&
          (!department || department.facilityId !== facilityId)
        ) {
          return { kind: "department_not_found" as const };
        }

        if (supervisorId != null) {
          const supervisor = lockedUsers.find(
            (candidate) => candidate.id === supervisorId,
          );
          if (
            !supervisor ||
            supervisor.facilityId !== facilityId ||
            !canSuperviseTarget(supervisor, {
              facilityId,
              role: role as User["role"],
            })
          ) {
            return { kind: "invalid_supervisor" as const };
          }
        }

        const existing = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email));
        if (existing.length > 0) return { kind: "email_conflict" as const };

        // Direct password provisioning is exceptional; invitation onboarding is
        // the default. Re-prove both administrator factors for every direct
        // account, even the least-privileged employee role. The route-wide
        // limiter bounds guesses and the factor is consumed transactionally.
        const stepUp = await verifyAdministrativeStepUp(
          tx,
          actor,
          currentPassword,
          stepUpCode,
        );
        if (stepUp !== "verified") return { kind: stepUp };

        const inserted = await tx
          .insert(usersTable)
          .values({
            email,
            passwordHash,
            name: body.name as string,
            nameAr: body.nameAr as string,
            role: role as User["role"],
            departmentId,
            supervisorId,
            facilityId,
            jobTitle: body.jobTitle as string,
            jobTitleAr: body.jobTitleAr as string,
            employeeNumber: body.employeeNumber as string,
            phone: (body.phone as string) ?? null,
            isActive: true,
            mustChangePassword: true,
          })
          .returning();
        const insertedUser = inserted[0];
        if (!insertedUser) throw new Error("Employee insert returned no row");

        await tx.insert(auditLogsTable).values({
          userId: actor.id,
          facilityId: insertedUser.facilityId,
          userName: actor.name,
          userNameAr: actor.nameAr,
          action: "Added employee",
          actionAr: "إضافة موظف",
          target: insertedUser.name,
          targetAr: insertedUser.nameAr,
          details: null,
          ipAddress: req.ip ?? null,
        });
        return { kind: "created" as const, user: insertedUser };
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        res.status(409).json({ message: "Email already registered" });
        return;
      }
      throw error;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    if (result.kind === "unauthorized") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "admin_mfa_required") {
      res.status(403).json({
        code: "admin_mfa_required",
        message: "Enable two-factor authentication on your admin account first",
        messageAr: "فعّل المصادقة الثنائية لحساب المسؤول أولاً",
      });
      return;
    }
    if (result.kind === "step_up_failed") {
      res.status(403).json({
        code: "step_up_failed",
        message: "Administrator step-up verification failed",
        messageAr: "فشل التحقق الإضافي من هوية المسؤول",
      });
      return;
    }
    if (result.kind === "role_forbidden") {
      res
        .status(403)
        .json({ message: "You are not allowed to assign this role" });
      return;
    }
    if (result.kind === "invalid_facility_id") {
      res.status(400).json({ message: "A valid facilityId is required" });
      return;
    }
    if (result.kind === "facility_not_found") {
      res.status(400).json({ message: "Facility not found" });
      return;
    }
    if (result.kind === "department_not_found") {
      res
        .status(400)
        .json({ message: "Department not found in the target facility" });
      return;
    }
    if (result.kind === "invalid_supervisor") {
      res.status(400).json({
        message:
          "Supervisor must be an active higher-ranked account in the target facility",
      });
      return;
    }
    if (result.kind === "email_conflict") {
      res.status(409).json({ message: "Email already registered" });
      return;
    }
    if (result.kind !== "created" || !result.user) {
      res.status(500).json({ message: "Internal server error" });
      return;
    }
    res.status(201).json(serializeUser(result.user));
  },
);

/**
 * Invite-only employee onboarding. Organization/profile fields are captured
 * here under administrator authentication; the public acceptance endpoint is
 * deliberately limited to the bearer token and a new password.
 */
router.post(
  "/employees/invitations",
  requireRole(...ADMIN_ROLES),
  employeeStepUpRateLimit,
  async (req, res) => {
    if (!isEmailConfigured()) {
      res.status(503).json({
        code: "email_delivery_unavailable",
        message:
          "Employee invitations are unavailable until email delivery is configured",
        messageAr:
          "دعوات الموظفين غير متاحة حتى يتم إعداد خدمة البريد الإلكتروني",
      });
      return;
    }

    const requestUser = getUser(req);
    const body =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    if (Object.prototype.hasOwnProperty.call(body, "password")) {
      res.status(400).json({
        message: "Password cannot be supplied when inviting an employee",
        messageAr: "لا يمكن تحديد كلمة المرور عند دعوة موظف",
      });
      return;
    }

    const name = requiredTrimmedString(body, "name", 200);
    const nameAr = requiredTrimmedString(body, "nameAr", 200);
    const emailValue = requiredTrimmedString(body, "email", 320);
    const jobTitle = requiredTrimmedString(body, "jobTitle", 200);
    const jobTitleAr = requiredTrimmedString(body, "jobTitleAr", 200);
    const employeeNumber = requiredTrimmedString(body, "employeeNumber", 100);
    const requestedRole =
      body.role == null
        ? ("employee" as const)
        : typeof body.role === "string" &&
            USER_ROLES.includes(body.role as User["role"])
          ? (body.role as User["role"])
          : null;
    const currentPassword = hasAllowedPasswordInputLength(body.currentPassword)
      ? body.currentPassword
      : null;
    const stepUpCode = requiredTrimmedString(body, "code", 128);
    const phoneValue = body.phone;
    const phone =
      phoneValue == null || phoneValue === ""
        ? null
        : typeof phoneValue === "string" &&
            /^\+9665[0-9]{8}$/.test(phoneValue.trim())
          ? phoneValue.trim()
          : undefined;
    if (
      !name ||
      !nameAr ||
      !emailValue ||
      !jobTitle ||
      !jobTitleAr ||
      !employeeNumber ||
      !requestedRole ||
      !currentPassword ||
      (isProtectedMfaUser(requestUser) && !stepUpCode) ||
      phone === undefined
    ) {
      res.status(400).json({
        message:
          "Valid employee profile and administrator verification fields are required",
        messageAr:
          "بيانات الموظف وبيانات تحقق المسؤول مطلوبة ويجب أن تكون صالحة",
      });
      return;
    }
    const email = emailValue.toLowerCase();
    if (!EMAIL_ADDRESS.test(email)) {
      res.status(400).json({
        message: "A valid email address is required",
        messageAr: "يجب إدخال بريد إلكتروني صالح",
      });
      return;
    }

    const requestedFacilityId =
      body.facilityId == null ? null : Number(body.facilityId);
    if (
      requestedFacilityId != null &&
      (!Number.isInteger(requestedFacilityId) || requestedFacilityId <= 0)
    ) {
      res
        .status(400)
        .json({ message: "facilityId must be a positive integer" });
      return;
    }
    const departmentId =
      body.departmentId == null ? null : Number(body.departmentId);
    if (
      departmentId != null &&
      (!Number.isInteger(departmentId) || departmentId <= 0)
    ) {
      res
        .status(400)
        .json({ message: "departmentId must be a positive integer" });
      return;
    }
    const supervisorId =
      body.supervisorId == null ? null : Number(body.supervisorId);
    if (
      supervisorId != null &&
      (!Number.isInteger(supervisorId) || supervisorId <= 0)
    ) {
      res
        .status(400)
        .json({ message: "supervisorId must be a positive integer" });
      return;
    }

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const invitationUrl = getEmployeeInvitationUrl(rawToken);
    if (!invitationUrl) {
      res.status(503).json({
        code: "email_delivery_unavailable",
        message:
          "Employee invitations are unavailable until email delivery is configured",
        messageAr:
          "دعوات الموظفين غير متاحة حتى يتم إعداد خدمة البريد الإلكتروني",
      });
      return;
    }

    let result;
    try {
      result = await db.transaction(async (tx) => {
        // Match the employee mutation lock order: department, involved user
        // rows, then the invitation/email serialization lock.
        const department =
          departmentId == null
            ? null
            : (
                await tx
                  .select({
                    id: departmentsTable.id,
                    facilityId: departmentsTable.facilityId,
                  })
                  .from(departmentsTable)
                  .where(
                    and(
                      eq(departmentsTable.id, departmentId),
                      isNull(departmentsTable.deletedAt),
                    ),
                  )
                  .for("key share")
              )[0];

        const userIds = [
          requestUser.id,
          ...(supervisorId ? [supervisorId] : []),
        ]
          .filter((value, index, values) => values.indexOf(value) === index)
          .sort((left, right) => left - right);
        const lockedUsers = await tx
          .select()
          .from(usersTable)
          .where(inArray(usersTable.id, userIds))
          .orderBy(usersTable.id)
          .for("update");
        const actor = lockedUsers.find(
          (candidate) => candidate.id === requestUser.id,
        );
        if (!isFreshActiveSessionActor(actor, requestUser)) {
          return { kind: "unauthorized" as const };
        }
        if (!ADMIN_ROLES.includes(actor.role)) {
          return { kind: "forbidden" as const };
        }
        if (!canAssignRole(actor, requestedRole)) {
          return { kind: "role_forbidden" as const };
        }
        const stepUp = await verifyAdministrativeStepUp(
          tx,
          actor,
          currentPassword,
          stepUpCode,
        );
        if (stepUp !== "verified") return { kind: stepUp };

        const facilityId =
          actor.role === "system_admin" && requestedFacilityId != null
            ? requestedFacilityId
            : actor.facilityId;
        if (!Number.isInteger(facilityId) || facilityId <= 0) {
          return { kind: "invalid_facility_id" as const };
        }
        const facility = await tx
          .select({ id: facilitiesTable.id })
          .from(facilitiesTable)
          .where(eq(facilitiesTable.id, facilityId));
        if (facility.length === 0)
          return { kind: "facility_not_found" as const };
        if (
          departmentId != null &&
          (!department || department.facilityId !== facilityId)
        ) {
          return { kind: "department_not_found" as const };
        }
        if (supervisorId != null) {
          const supervisor = lockedUsers.find(
            (candidate) => candidate.id === supervisorId,
          );
          if (
            !supervisor ||
            supervisor.facilityId !== facilityId ||
            !canSuperviseTarget(supervisor, {
              facilityId,
              role: requestedRole,
            })
          ) {
            return { kind: "invalid_supervisor" as const };
          }
        }

        // Serialize every create/accept decision for this normalized email.
        // This prevents two concurrent administrators from leaving two active
        // links and closes the race with acceptance/user uniqueness.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${email}, 0))`,
        );
        const existing = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, email));
        if (existing.length > 0) return { kind: "email_conflict" as const };

        const now = new Date();
        await tx
          .update(employeeInvitationsTable)
          .set({ revokedAt: now })
          .where(
            and(
              eq(employeeInvitationsTable.email, email),
              isNull(employeeInvitationsTable.acceptedAt),
              isNull(employeeInvitationsTable.revokedAt),
              gt(employeeInvitationsTable.expiresAt, now),
            ),
          );
        const invitation = (
          await tx
            .insert(employeeInvitationsTable)
            .values({
              email,
              tokenHash,
              invitedBy: actor.id,
              facilityId,
              role: requestedRole,
              departmentId,
              supervisorId,
              name,
              nameAr,
              jobTitle,
              jobTitleAr,
              employeeNumber,
              phone,
              expiresAt: new Date(now.getTime() + EMPLOYEE_INVITATION_TTL_MS),
            })
            .returning({ id: employeeInvitationsTable.id })
        )[0];
        if (!invitation) throw new Error("Invitation insert returned no row");
        await tx.insert(auditLogsTable).values({
          userId: actor.id,
          facilityId,
          userName: actor.name,
          userNameAr: actor.nameAr,
          action: "Created employee invitation",
          actionAr: "إنشاء دعوة موظف",
          target: name,
          targetAr: nameAr,
          details: JSON.stringify({
            role: requestedRole,
            departmentId,
            supervisorId,
          }),
          ipAddress: req.ip ?? null,
        });
        return { kind: "created" as const, invitationId: invitation.id };
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        res.status(409).json({
          code: "email_conflict",
          message: "An account already exists for this email address",
          messageAr: "يوجد حساب مسجل مسبقًا بهذا البريد الإلكتروني",
        });
        return;
      }
      throw error;
    }

    if (result.kind === "unauthorized") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    if (result.kind === "role_forbidden") {
      res.status(403).json({
        code: "role_forbidden",
        message: "You are not allowed to assign this role",
        messageAr: "لا تملك صلاحية تعيين هذا الدور",
      });
      return;
    }
    if (result.kind === "admin_mfa_required") {
      res.status(403).json({
        code: "admin_mfa_required",
        message: "Enable two-factor authentication on your admin account first",
        messageAr: "فعّل المصادقة الثنائية لحساب المسؤول أولاً",
      });
      return;
    }
    if (result.kind === "step_up_failed") {
      res.status(403).json({
        code: "step_up_failed",
        message: "Administrator step-up verification failed",
        messageAr: "فشل التحقق الإضافي من هوية المسؤول",
      });
      return;
    }
    if (result.kind === "invalid_facility_id") {
      res.status(400).json({ message: "A valid facilityId is required" });
      return;
    }
    if (result.kind === "facility_not_found") {
      res.status(400).json({ message: "Facility not found" });
      return;
    }
    if (result.kind === "department_not_found") {
      res.status(400).json({
        message: "Department not found in the target facility",
      });
      return;
    }
    if (result.kind === "invalid_supervisor") {
      res.status(400).json({
        message:
          "Supervisor must be an active higher-ranked account in the target facility",
      });
      return;
    }
    if (result.kind === "email_conflict") {
      res.status(409).json({
        code: "email_conflict",
        message: "An account already exists for this email address",
        messageAr: "يوجد حساب مسجل مسبقًا بهذا البريد الإلكتروني",
      });
      return;
    }
    if (result.kind !== "created" || result.invitationId == null) {
      res.status(500).json({ message: "Internal server error" });
      return;
    }
    const invitationId = result.invitationId;

    try {
      await sendEmail({
        to: email,
        subject:
          "دعوة للانضمام إلى وثائقي الصحي | HealthDocs employee invitation",
        html: employeeInvitationEmail({ nameAr, name, invitationUrl }),
        text: employeeInvitationText({ nameAr, name, invitationUrl }),
        idempotencyKey: createEmailIdempotencyKey(
          "employee-invitation",
          tokenHash,
        ),
      });
    } catch {
      try {
        await db.transaction(async (tx) => {
          const revoked = await tx
            .update(employeeInvitationsTable)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(employeeInvitationsTable.id, invitationId),
                isNull(employeeInvitationsTable.acceptedAt),
                isNull(employeeInvitationsTable.revokedAt),
              ),
            )
            .returning({
              id: employeeInvitationsTable.id,
              facilityId: employeeInvitationsTable.facilityId,
              name: employeeInvitationsTable.name,
              nameAr: employeeInvitationsTable.nameAr,
            });
          const invitation = revoked[0];
          if (!invitation) return;
          await tx.insert(auditLogsTable).values({
            userId: requestUser.id,
            facilityId: invitation.facilityId,
            userName: requestUser.name,
            userNameAr: requestUser.nameAr,
            action: "Revoked undelivered employee invitation",
            actionAr: "إلغاء دعوة موظف تعذر إرسالها",
            target: invitation.name,
            targetAr: invitation.nameAr,
            details: null,
            ipAddress: req.ip ?? null,
          });
        });
      } catch {
        // The normal path keeps revocation and audit atomic. If audit storage
        // itself fails, make one fail-closed revocation attempt so a provider
        // that accepted the message before throwing cannot leave a live link.
        try {
          await db
            .update(employeeInvitationsTable)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(employeeInvitationsTable.id, invitationId),
                isNull(employeeInvitationsTable.acceptedAt),
                isNull(employeeInvitationsTable.revokedAt),
              ),
            );
          logger.error(
            { invitationId },
            "Employee invitation was revoked without an audit row after audit persistence failed",
          );
        } catch {
          logger.error(
            { invitationId },
            "Undelivered employee invitation could not be safely revoked",
          );
          throw new Error("Undelivered invitation revocation failed");
        }
      }
      logger.error(
        { invitationId },
        "Employee invitation delivery failed and the invitation was revoked",
      );
      res.status(502).json({
        code: "invitation_delivery_failed",
        message:
          "The invitation could not be delivered; no active invitation remains",
        messageAr: "تعذر إرسال الدعوة ولم تظل أي دعوة نشطة",
      });
      return;
    }

    res.status(201).json({
      status: "sent",
      message: "Employee invitation sent",
      messageAr: "تم إرسال دعوة الموظف",
    });
  },
);

/**
 * Active invitation directory. Hospital administrators are constrained in the
 * database predicate to their own facility; system administrators may inspect
 * all facilities or select one explicitly. Token digests are never selected.
 */
router.get(
  "/employees/invitations",
  requireRole(...ADMIN_ROLES),
  async (req, res) => {
    const actor = getUser(req);
    const rawFacilityId = req.query.facilityId;
    let requestedFacilityId: number | null = null;
    if (rawFacilityId !== undefined) {
      if (typeof rawFacilityId !== "string" || !/^\d+$/.test(rawFacilityId)) {
        res
          .status(400)
          .json({ message: "facilityId must be a positive integer" });
        return;
      }
      requestedFacilityId = Number(rawFacilityId);
      if (
        !Number.isSafeInteger(requestedFacilityId) ||
        requestedFacilityId < 1
      ) {
        res
          .status(400)
          .json({ message: "facilityId must be a positive integer" });
        return;
      }
    }

    const now = new Date();
    const activeInvitation = and(
      isNull(employeeInvitationsTable.acceptedAt),
      isNull(employeeInvitationsTable.revokedAt),
      gt(employeeInvitationsTable.expiresAt, now),
    );
    const scope =
      actor.role === "system_admin"
        ? requestedFacilityId == null
          ? activeInvitation
          : and(
              activeInvitation,
              eq(employeeInvitationsTable.facilityId, requestedFacilityId),
            )
        : and(
            activeInvitation,
            eq(employeeInvitationsTable.facilityId, actor.facilityId),
          );
    const invitations = await db
      .select({
        id: employeeInvitationsTable.id,
        email: employeeInvitationsTable.email,
        name: employeeInvitationsTable.name,
        nameAr: employeeInvitationsTable.nameAr,
        jobTitle: employeeInvitationsTable.jobTitle,
        jobTitleAr: employeeInvitationsTable.jobTitleAr,
        employeeNumber: employeeInvitationsTable.employeeNumber,
        phone: employeeInvitationsTable.phone,
        facilityId: employeeInvitationsTable.facilityId,
        role: employeeInvitationsTable.role,
        departmentId: employeeInvitationsTable.departmentId,
        supervisorId: employeeInvitationsTable.supervisorId,
        expiresAt: employeeInvitationsTable.expiresAt,
        createdAt: employeeInvitationsTable.createdAt,
      })
      .from(employeeInvitationsTable)
      .where(scope)
      .orderBy(
        desc(employeeInvitationsTable.createdAt),
        desc(employeeInvitationsTable.id),
      )
      .limit(200);
    res.json(invitations);
  },
);

router.delete(
  "/employees/invitations/:id",
  requireRole(...ADMIN_ROLES),
  employeeStepUpRateLimit,
  async (req, res) => {
    const requestUser = getUser(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(404).json({ message: "Invitation not found" });
      return;
    }

    const body =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    if (
      Object.keys(body).some(
        (key) => key !== "currentPassword" && key !== "code",
      )
    ) {
      res.status(400).json({ message: "Invalid request" });
      return;
    }
    const currentPassword = hasAllowedPasswordInputLength(body.currentPassword)
      ? body.currentPassword
      : null;
    const stepUpCode = requiredTrimmedString(body, "code", 128);

    const result = await db.transaction(async (tx) => {
      // Keep lock order aligned with invitation acceptance: involved user rows
      // before the invitation row. This also rechecks the session snapshot
      // immediately before the privileged write.
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
      if (!ADMIN_ROLES.includes(actor.role)) {
        return { kind: "forbidden" as const };
      }

      const invitation = (
        await tx
          .select()
          .from(employeeInvitationsTable)
          .where(eq(employeeInvitationsTable.id, id))
          .for("update")
      )[0];
      const now = new Date();
      if (
        !invitation ||
        invitation.acceptedAt ||
        invitation.revokedAt ||
        invitation.expiresAt.getTime() <= now.getTime() ||
        (actor.role === "hospital_admin" &&
          invitation.facilityId !== actor.facilityId)
      ) {
        return { kind: "not_found" as const };
      }
      const stepUp = await verifyAdministrativeStepUp(
        tx,
        actor,
        currentPassword,
        stepUpCode,
      );
      if (stepUp !== "verified") return { kind: stepUp };

      const revoked = await tx
        .update(employeeInvitationsTable)
        .set({ revokedAt: now })
        .where(
          and(
            eq(employeeInvitationsTable.id, invitation.id),
            isNull(employeeInvitationsTable.acceptedAt),
            isNull(employeeInvitationsTable.revokedAt),
            gt(employeeInvitationsTable.expiresAt, now),
          ),
        )
        .returning({ id: employeeInvitationsTable.id });
      if (revoked.length === 0) return { kind: "not_found" as const };
      await tx.insert(auditLogsTable).values({
        userId: actor.id,
        facilityId: invitation.facilityId,
        userName: actor.name,
        userNameAr: actor.nameAr,
        action: "Revoked employee invitation",
        actionAr: "إلغاء دعوة موظف",
        target: invitation.name,
        targetAr: invitation.nameAr,
        details: null,
        ipAddress: req.ip ?? null,
      });
      return { kind: "revoked" as const };
    });

    if (result.kind === "unauthorized") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    if (result.kind === "not_found") {
      res.status(404).json({ message: "Invitation not found" });
      return;
    }
    if (result.kind === "admin_mfa_required") {
      res.status(403).json({
        code: "admin_mfa_required",
        message: "Enable two-factor authentication on your admin account first",
        messageAr: "فعّل المصادقة الثنائية لحساب المسؤول أولاً",
      });
      return;
    }
    if (result.kind === "step_up_failed") {
      res.status(403).json({
        code: "step_up_failed",
        message: "Administrator step-up verification failed",
        messageAr: "فشل التحقق الإضافي من هوية المسؤول",
      });
      return;
    }
    res.status(204).end();
  },
);

router.get("/employees/:id", async (req, res) => {
  const user = getUser(req);
  const id = Number(req.params.id);
  const scoped = await getCredentialScopedUsers(user);
  const target = scoped.find((u) => u.id === id);
  if (!target) {
    res.status(404).json({ message: "Employee not found" });
    return;
  }
  const creds = await db
    .select()
    .from(credentialsTable)
    .where(
      and(
        eq(credentialsTable.employeeId, id),
        isNull(credentialsTable.deletedAt),
      ),
    );
  const policies = await getPolicies(target.facilityId);
  const stats = computeEmployeeStats(target, creds, policies);
  const departments = await getDepartments(target.facilityId);
  const dept =
    target.departmentId != null
      ? departments.find((d) => d.id === target.departmentId)
      : undefined;
  let supervisor: User | undefined;
  if (target.supervisorId != null) {
    const sup = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, target.supervisorId));
    supervisor = sup[0];
  }
  res.json({
    ...serializeUser(target),
    ...(dept
      ? { department: { id: dept.id, name: dept.name, nameAr: dept.nameAr } }
      : {}),
    complianceRate: stats.complianceRate,
    totalCredentials: stats.totalCredentials,
    expiredCount: stats.expiredCount,
    expiringCount: stats.expiringCount,
    missingCount: stats.missingCount,
    isAtRisk: stats.isAtRisk,
    credentials: creds
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
      .map((c) => serializeCredential(c)),
    missingCredentials: stats.missingTypes,
    ...(supervisor ? { supervisor: employeeSummary(supervisor) } : {}),
  });
});

router.patch(
  "/employees/:id",
  requireRole(...MANAGER_ROLES),
  rateLimitOrganizationalPatch,
  async (req, res) => {
    const requestUser = getUser(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const phoneWasRequested = Object.prototype.hasOwnProperty.call(
      body,
      "phone",
    );
    const requestedPhone =
      body.phone === null
        ? null
        : typeof body.phone === "string"
          ? body.phone.trim()
          : null;
    const phoneInputIsValid =
      !phoneWasRequested ||
      body.phone === null ||
      (typeof body.phone === "string" &&
        /^\+9665[0-9]{8}$/.test(requestedPhone ?? ""));
    const currentPassword = hasAllowedPasswordInputLength(body.currentPassword)
      ? body.currentPassword
      : "";
    const stepUpCode = requiredTrimmedString(body, "code", 128) ?? "";
    const changesOrganization = ACCOUNT_AUDIT_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(body, field),
    );
    const profilePatch: Record<string, unknown> = {};
    for (const f of ["name", "nameAr", "jobTitle", "jobTitleAr"]) {
      if (typeof body[f] === "string") profilePatch[f] = body[f];
    }

    const roleWasRequested = "role" in body;
    const requestedRole =
      typeof body.role === "string" &&
      USER_ROLES.includes(body.role as User["role"])
        ? (body.role as User["role"])
        : null;

    const departmentWasRequested = "departmentId" in body;
    let requestedDepartmentId: number | null = null;
    let departmentInputIsValid = true;
    if ("departmentId" in body) {
      requestedDepartmentId =
        body.departmentId != null ? Number(body.departmentId) : null;
      if (
        requestedDepartmentId != null &&
        (!Number.isInteger(requestedDepartmentId) || requestedDepartmentId <= 0)
      ) {
        departmentInputIsValid = false;
      }
    }

    const supervisorWasRequested = "supervisorId" in body;
    let requestedSupervisorId: number | null = null;
    let supervisorInputIsValid = true;
    if ("supervisorId" in body) {
      requestedSupervisorId =
        body.supervisorId != null ? Number(body.supervisorId) : null;
      if (
        requestedSupervisorId != null &&
        (!Number.isInteger(requestedSupervisorId) || requestedSupervisorId <= 0)
      ) {
        supervisorInputIsValid = false;
      }
    }

    const activeWasRequested = "isActive" in body;
    const activeInputIsValid =
      !activeWasRequested || typeof body.isActive === "boolean";

    const result = await db.transaction(async (tx) => {
      // Department deletion uses the same department -> users lock order. A
      // shared lock here prevents the target department from being retired
      // after validation but before assignment, without deadlocking deletion.
      const lockedDepartment =
        departmentWasRequested &&
        departmentInputIsValid &&
        requestedDepartmentId != null
          ? (
              await tx
                .select({
                  id: departmentsTable.id,
                  facilityId: departmentsTable.facilityId,
                })
                .from(departmentsTable)
                .where(
                  and(
                    eq(departmentsTable.id, requestedDepartmentId),
                    isNull(departmentsTable.deletedAt),
                  ),
                )
                .for("key share")
            )[0]
          : null;

      // Authentication precedes this handler, so the actor's role/scope could
      // otherwise change between middleware and the write. After any
      // department lock, lock every user row involved in the decision together
      // and in primary-key order. Including the proposed supervisor closes that
      // reference's eligibility race too.
      const userIds = [
        requestUser.id,
        id,
        ...(supervisorInputIsValid && requestedSupervisorId != null
          ? [requestedSupervisorId]
          : []),
      ]
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort((left, right) => left - right);
      const lockedUsers = await tx
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, userIds))
        .orderBy(usersTable.id)
        .for("update");
      const actor = lockedUsers.find((entry) => entry.id === requestUser.id);
      const target = lockedUsers.find((entry) => entry.id === id);

      if (!isFreshActiveSessionActor(actor, requestUser)) {
        return { kind: "unauthorized" as const };
      }
      if (!MANAGER_ROLES.includes(actor.role)) {
        return { kind: "forbidden" as const };
      }
      if (!target || !isUserInScope(actor, target)) {
        return { kind: "not_found" as const };
      }
      // Managers may edit themselves (non-organizational fields) or only a
      // currently scoped, strictly lower-ranked account.
      if (target.id !== actor.id && !canManageTarget(actor, target)) {
        return { kind: "not_found" as const };
      }
      if (target.id === actor.id && changesOrganization) {
        return { kind: "self_organization" as const };
      }
      if (!ADMIN_ROLES.includes(actor.role) && changesOrganization) {
        return { kind: "admin_required" as const };
      }
      if (!phoneInputIsValid) {
        return { kind: "invalid_phone" as const };
      }
      // Keep legacy edit forms working when they echo the existing number. An
      // unverified contact number may be corrected or cleared, but a verified
      // identity factor requires a dedicated re-verification flow.
      if (
        phoneWasRequested &&
        requestedPhone !== target.phone &&
        target.phoneVerifiedAt != null
      ) {
        return { kind: "phone_reverification_required" as const };
      }

      // A role change can make an existing supervisor relationship invalid.
      // When a supervisor is already assigned, require the caller to resubmit
      // that supervisor (or clear it) so the row is included in the stable
      // lock set above and the relationship is revalidated atomically.
      if (
        roleWasRequested &&
        requestedRole &&
        requestedRole !== target.role &&
        target.supervisorId != null &&
        !supervisorWasRequested
      ) {
        return { kind: "supervisor_revalidation_required" as const };
      }

      const patch: Record<string, unknown> = { ...profilePatch };
      let invalidatesTargetSessions = false;
      if (phoneWasRequested && requestedPhone !== target.phone) {
        patch.phone = requestedPhone;
        patch.phoneVerifiedAt = null;
      }
      if (roleWasRequested) {
        if (!requestedRole) return { kind: "invalid_role" as const };
        if (requestedRole !== target.role) {
          if (!canAssignRole(actor, requestedRole)) {
            return { kind: "role_forbidden" as const };
          }
          patch.role = requestedRole;
          invalidatesTargetSessions = true;
        }
      }

      if (departmentWasRequested) {
        if (!departmentInputIsValid) {
          return { kind: "invalid_department_id" as const };
        }
        if (
          requestedDepartmentId != null &&
          (!lockedDepartment ||
            lockedDepartment.facilityId !== target.facilityId)
        ) {
          return { kind: "department_not_found" as const };
        }
        if (requestedDepartmentId !== target.departmentId) {
          patch.departmentId = requestedDepartmentId;
          invalidatesTargetSessions = true;
        }
      }

      if (supervisorWasRequested) {
        if (!supervisorInputIsValid) {
          return { kind: "invalid_supervisor_id" as const };
        }
        if (requestedSupervisorId === target.id) {
          return { kind: "self_supervisor" as const };
        }
        if (requestedSupervisorId != null) {
          const supervisor = lockedUsers.find(
            (entry) => entry.id === requestedSupervisorId,
          );
          if (
            !supervisor ||
            supervisor.facilityId !== target.facilityId ||
            !canSuperviseTarget(supervisor, {
              facilityId: target.facilityId,
              role: requestedRole ?? target.role,
            })
          ) {
            return { kind: "invalid_supervisor" as const };
          }
        }
        if (requestedSupervisorId !== target.supervisorId) {
          patch.supervisorId = requestedSupervisorId;
          invalidatesTargetSessions = true;
        }
      }

      if (activeWasRequested) {
        if (!activeInputIsValid) return { kind: "invalid_active" as const };
        if ((body.isActive as boolean) !== target.isActive) {
          patch.isActive = body.isActive as boolean;
          invalidatesTargetSessions = true;
        }
      }

      // Role, scope, reporting-line, and activation changes require fresh
      // administrator verification. Every administrator re-proves their
      // password; only the immutable protected account also consumes its
      // replay-safe second factor.
      const requiresAdministrativeStepUp =
        Object.prototype.hasOwnProperty.call(patch, "role") ||
        Object.prototype.hasOwnProperty.call(patch, "departmentId") ||
        Object.prototype.hasOwnProperty.call(patch, "supervisorId") ||
        Object.prototype.hasOwnProperty.call(patch, "isActive");
      if (requiresAdministrativeStepUp) {
        const stepUp = await verifyAdministrativeStepUp(
          tx,
          actor,
          currentPassword,
          stepUpCode,
        );
        if (stepUp !== "verified") return { kind: stepUp };
      }
      if (invalidatesTargetSessions) {
        patch.sessionVersion = sql`${usersTable.sessionVersion} + 1`;
      }

      if (Object.keys(patch).length === 0) {
        return { kind: "updated" as const, user: target };
      }
      const updated = await tx
        .update(usersTable)
        .set(patch)
        .where(
          and(
            eq(usersTable.id, id),
            eq(usersTable.sessionVersion, target.sessionVersion),
          ),
        )
        .returning();
      const updatedUser = updated[0];
      if (!updatedUser) return { kind: "conflict" as const };

      await tx.insert(auditLogsTable).values({
        userId: actor.id,
        facilityId: updatedUser.facilityId,
        userName: actor.name,
        userNameAr: actor.nameAr,
        action: "Updated employee",
        actionAr: "تحديث موظف",
        target: updatedUser.name,
        targetAr: updatedUser.nameAr,
        details: accountChangeDetails(target, updatedUser),
        ipAddress: req.ip ?? null,
      });
      return { kind: "updated" as const, user: updatedUser };
    });

    if (result.kind === "not_found") {
      res.status(404).json({ message: "Employee not found" });
      return;
    }
    if (result.kind === "forbidden") {
      res
        .status(403)
        .json({ message: "Not authorized to modify this employee" });
      return;
    }
    if (result.kind === "unauthorized") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "admin_mfa_required") {
      res.status(403).json({
        code: "admin_mfa_required",
        message: "Enable two-factor authentication on your admin account first",
        messageAr: "فعّل المصادقة الثنائية لحساب المسؤول أولاً",
      });
      return;
    }
    if (result.kind === "step_up_failed") {
      res.status(403).json({
        code: "step_up_failed",
        message: "Administrator step-up verification failed",
        messageAr: "فشل التحقق الإضافي من هوية المسؤول",
      });
      return;
    }
    if (result.kind === "self_organization") {
      res.status(403).json({
        message: "You cannot change your own role or organizational scope",
      });
      return;
    }
    if (result.kind === "admin_required") {
      res.status(403).json({
        message: "Only administrators may change organizational fields",
      });
      return;
    }
    if (result.kind === "phone_reverification_required") {
      res.status(400).json({
        code: "phone_reverification_required",
        message:
          "A verified phone number cannot be changed through the employee profile endpoint",
        messageAr: "لا يمكن تغيير رقم جوال موثّق من خلال مسار تعديل ملف الموظف",
      });
      return;
    }
    if (result.kind === "invalid_phone") {
      res.status(400).json({
        code: "invalid_phone",
        message: "Phone must be a Saudi mobile number in E.164 format or null",
        messageAr: "يجب أن يكون رقم الجوال سعوديًا بصيغة E.164 أو فارغًا",
      });
      return;
    }
    if (result.kind === "invalid_role") {
      res.status(400).json({ message: "Invalid role" });
      return;
    }
    if (result.kind === "role_forbidden") {
      res
        .status(403)
        .json({ message: "You are not allowed to assign this role" });
      return;
    }
    if (result.kind === "invalid_department_id") {
      res
        .status(400)
        .json({ message: "departmentId must be a positive integer" });
      return;
    }
    if (result.kind === "department_not_found") {
      res
        .status(400)
        .json({ message: "Department not found in the employee facility" });
      return;
    }
    if (result.kind === "invalid_supervisor_id") {
      res
        .status(400)
        .json({ message: "supervisorId must be a positive integer" });
      return;
    }
    if (result.kind === "supervisor_revalidation_required") {
      res.status(400).json({
        code: "supervisor_revalidation_required",
        message:
          "Include supervisorId when changing the role of an employee who already has a supervisor",
        messageAr: "أرسل معرّف المشرف عند تغيير دور موظف لديه مشرف حاليًا",
      });
      return;
    }
    if (result.kind === "self_supervisor") {
      res
        .status(400)
        .json({ message: "An employee cannot supervise themselves" });
      return;
    }
    if (result.kind === "invalid_supervisor") {
      res.status(400).json({
        message:
          "Supervisor must be an active higher-ranked account in the employee facility",
      });
      return;
    }
    if (result.kind === "invalid_active") {
      res.status(400).json({ message: "isActive must be a boolean" });
      return;
    }
    if (result.kind === "conflict") {
      res
        .status(409)
        .json({ message: "Employee changed — reload it and try again" });
      return;
    }
    if (result.kind !== "updated" || !result.user) {
      res.status(500).json({ message: "Internal server error" });
      return;
    }
    res.json(serializeUser(result.user));
  },
);

router.delete(
  "/employees/:id",
  requireRole(...ADMIN_ROLES),
  employeeStepUpRateLimit,
  async (req, res) => {
    const requestUser = getUser(req);
    const body =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const currentPassword = hasAllowedPasswordInputLength(body.currentPassword)
      ? body.currentPassword
      : "";
    const stepUpCode = requiredTrimmedString(body, "code", 128) ?? "";
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }
    // Credential and audit history are regulated records. A DELETE request is
    // therefore implemented as a reversible deactivation and session revocation.
    const result = await db.transaction(async (tx) => {
      const lockedUsers = await tx
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, [requestUser.id, id]))
        .orderBy(usersTable.id)
        .for("update");
      const actor = lockedUsers.find((entry) => entry.id === requestUser.id);
      const target = lockedUsers.find((entry) => entry.id === id);
      if (!isFreshActiveSessionActor(actor, requestUser)) {
        return { kind: "unauthorized" as const };
      }
      if (!ADMIN_ROLES.includes(actor.role)) {
        return { kind: "forbidden" as const };
      }
      if (!target || !isUserInScope(actor, target)) {
        return { kind: "not_found" as const };
      }
      if (target.id === actor.id) return { kind: "self" as const };
      if (!canManageTarget(actor, target)) {
        return { kind: "not_found" as const };
      }
      const stepUp = await verifyAdministrativeStepUp(
        tx,
        actor,
        currentPassword,
        stepUpCode,
      );
      if (stepUp !== "verified") return { kind: stepUp };
      if (!target.isActive) return { kind: "deactivated" as const };
      const updated = await tx
        .update(usersTable)
        .set({
          isActive: false,
          sessionVersion: sql`${usersTable.sessionVersion} + 1`,
        })
        .where(
          and(
            eq(usersTable.id, id),
            eq(usersTable.sessionVersion, target.sessionVersion),
          ),
        )
        .returning();
      const updatedUser = updated[0];
      if (!updatedUser) return { kind: "conflict" as const };
      await tx.insert(auditLogsTable).values({
        userId: actor.id,
        facilityId: target.facilityId,
        userName: actor.name,
        userNameAr: actor.nameAr,
        action: "Deactivated employee",
        actionAr: "إيقاف موظف",
        target: updatedUser.name,
        targetAr: updatedUser.nameAr,
        details: accountChangeDetails(target, updatedUser),
        ipAddress: req.ip ?? null,
      });
      return { kind: "deactivated" as const };
    });

    if (result.kind === "not_found") {
      res.status(404).json({ message: "Employee not found" });
      return;
    }
    if (result.kind === "self") {
      res.status(400).json({ message: "Cannot delete your own account" });
      return;
    }
    if (result.kind === "forbidden") {
      res
        .status(403)
        .json({ message: "Not authorized to delete this employee" });
      return;
    }
    if (result.kind === "unauthorized") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "admin_mfa_required") {
      res.status(403).json({
        code: "admin_mfa_required",
        message: "Enable two-factor authentication on your admin account first",
        messageAr: "فعّل المصادقة الثنائية لحساب المسؤول أولاً",
      });
      return;
    }
    if (result.kind === "step_up_failed") {
      res.status(403).json({
        code: "step_up_failed",
        message: "Administrator step-up verification failed",
        messageAr: "فشل التحقق الإضافي من هوية المسؤول",
      });
      return;
    }
    if (result.kind === "conflict") {
      res
        .status(409)
        .json({ message: "Employee changed — reload it and try again" });
      return;
    }
    res.status(204).end();
  },
);

async function setActive(
  req: Request,
  res: Response,
  isActive: boolean,
): Promise<void> {
  const requestUser = getUser(req);
  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const currentPassword = hasAllowedPasswordInputLength(body.currentPassword)
    ? body.currentPassword
    : "";
  const stepUpCode = requiredTrimmedString(body, "code", 128) ?? "";
  const id = Number((req.params as Record<string, string>).id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(404).json({ message: "Employee not found" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const lockedUsers = await tx
      .select()
      .from(usersTable)
      .where(inArray(usersTable.id, [requestUser.id, id]))
      .orderBy(usersTable.id)
      .for("update");
    const actor = lockedUsers.find((entry) => entry.id === requestUser.id);
    const target = lockedUsers.find((entry) => entry.id === id);
    if (!isFreshActiveSessionActor(actor, requestUser)) {
      return { kind: "unauthorized" as const };
    }
    if (!ADMIN_ROLES.includes(actor.role)) {
      return { kind: "forbidden" as const };
    }
    if (!target || !isUserInScope(actor, target)) {
      return { kind: "not_found" as const };
    }
    if (target.id === actor.id) return { kind: "self" as const };
    if (!canManageTarget(actor, target)) {
      return { kind: "not_found" as const };
    }
    const stepUp = await verifyAdministrativeStepUp(
      tx,
      actor,
      currentPassword,
      stepUpCode,
    );
    if (stepUp !== "verified") return { kind: stepUp };
    if (target.isActive === isActive) {
      return { kind: "updated" as const, user: target };
    }
    const updated = await tx
      .update(usersTable)
      .set({
        isActive,
        // Activation must revoke old tokens too; inactive accounts may still
        // have an otherwise-valid JWT that must not revive after reactivation.
        sessionVersion: sql`${usersTable.sessionVersion} + 1`,
      })
      .where(
        and(
          eq(usersTable.id, id),
          eq(usersTable.sessionVersion, target.sessionVersion),
        ),
      )
      .returning();
    const updatedUser = updated[0];
    if (!updatedUser) return { kind: "conflict" as const };

    await tx.insert(auditLogsTable).values({
      userId: actor.id,
      facilityId: updatedUser.facilityId,
      userName: actor.name,
      userNameAr: actor.nameAr,
      action: isActive ? "Activated employee" : "Deactivated employee",
      actionAr: isActive ? "تفعيل موظف" : "إيقاف موظف",
      target: updatedUser.name,
      targetAr: updatedUser.nameAr,
      details: accountChangeDetails(target, updatedUser),
      ipAddress: req.ip ?? null,
    });
    return { kind: "updated" as const, user: updatedUser };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ message: "Employee not found" });
    return;
  }
  if (result.kind === "self") {
    res
      .status(400)
      .json({ message: "Cannot change activation of your own account" });
    return;
  }
  if (result.kind === "forbidden") {
    res.status(403).json({ message: "Not authorized to modify this employee" });
    return;
  }
  if (result.kind === "unauthorized") {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  if (result.kind === "admin_mfa_required") {
    res.status(403).json({
      code: "admin_mfa_required",
      message: "Enable two-factor authentication on your admin account first",
      messageAr: "فعّل المصادقة الثنائية لحساب المسؤول أولاً",
    });
    return;
  }
  if (result.kind === "step_up_failed") {
    res.status(403).json({
      code: "step_up_failed",
      message: "Administrator step-up verification failed",
      messageAr: "فشل التحقق الإضافي من هوية المسؤول",
    });
    return;
  }
  if (result.kind === "conflict") {
    res
      .status(409)
      .json({ message: "Employee changed — reload it and try again" });
    return;
  }
  if (result.kind !== "updated" || !result.user) {
    res.status(500).json({ message: "Internal server error" });
    return;
  }
  res.json(serializeUser(result.user));
}

router.post(
  "/employees/:id/activate",
  requireRole(...ADMIN_ROLES),
  employeeStepUpRateLimit,
  (req, res) => setActive(req, res, true),
);
router.post(
  "/employees/:id/deactivate",
  requireRole(...ADMIN_ROLES),
  employeeStepUpRateLimit,
  (req, res) => setActive(req, res, false),
);

export default router;
