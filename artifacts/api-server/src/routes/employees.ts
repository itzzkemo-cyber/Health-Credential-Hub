import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  usersTable,
  credentialsTable,
  facilitiesTable,
  departmentsTable,
  auditLogsTable,
  USER_ROLES,
  type User,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  requireAuth,
  requireRole,
  getUser,
  hashPassword,
  MANAGER_ROLES,
  ADMIN_ROLES,
} from "../lib/auth";
import {
  getScopedUsers,
  getCredentialScopedUsers,
  getCredentialsFor,
  getPolicies,
  computeEmployeeStats,
  serializeUser,
  serializeCredential,
  employeeSummary,
  getDepartments,
  logAudit,
} from "../lib/helpers";
import { canAssignRole, canManageTarget } from "../lib/roleHierarchy";

const router: IRouter = Router();

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

router.post("/employees", requireRole(...ADMIN_ROLES), async (req, res) => {
  const user = getUser(req);
  const body = req.body as Record<string, unknown>;
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
  if (!canAssignRole(user, role as User["role"])) {
    res
      .status(403)
      .json({ message: "You are not allowed to assign this role" });
    return;
  }
  const email = (body.email as string).toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ message: "A valid email address is required" });
    return;
  }
  if ((body.password as string).length < 12) {
    res
      .status(400)
      .json({ message: "Password must contain at least 12 characters" });
    return;
  }
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (existing.length > 0) {
    res.status(409).json({ message: "Email already registered" });
    return;
  }
  const facilityId =
    user.role === "system_admin" && body.facilityId != null
      ? Number(body.facilityId)
      : user.facilityId;
  if (!Number.isInteger(facilityId) || facilityId <= 0) {
    res.status(400).json({ message: "A valid facilityId is required" });
    return;
  }
  const facility = await db
    .select({ id: facilitiesTable.id })
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, facilityId));
  if (facility.length === 0) {
    res.status(400).json({ message: "Facility not found" });
    return;
  }
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
  if (departmentId != null) {
    const department = await db
      .select({ id: departmentsTable.id })
      .from(departmentsTable)
      .where(
        and(
          eq(departmentsTable.id, departmentId),
          eq(departmentsTable.facilityId, facilityId),
        ),
      );
    if (department.length === 0) {
      res
        .status(400)
        .json({ message: "Department not found in the target facility" });
      return;
    }
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
  if (supervisorId != null) {
    const supervisor = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, supervisorId),
          eq(usersTable.facilityId, facilityId),
        ),
      );
    if (supervisor.length === 0) {
      res
        .status(400)
        .json({ message: "Supervisor not found in the target facility" });
      return;
    }
  }
  const passwordHash = await hashPassword(body.password as string);
  let created: User;
  try {
    created = await db.transaction(async (tx) => {
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
        userId: user.id,
        facilityId: insertedUser.facilityId,
        userName: user.name,
        userNameAr: user.nameAr,
        action: "Added employee",
        actionAr: "إضافة موظف",
        target: insertedUser.name,
        targetAr: insertedUser.nameAr,
        details: null,
        ipAddress: req.ip ?? null,
      });
      return insertedUser;
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      res.status(409).json({ message: "Email already registered" });
      return;
    }
    throw error;
  }
  res.status(201).json(serializeUser(created));
});

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
  async (req, res) => {
    const user = getUser(req);
    const id = Number(req.params.id);
    const scoped = await getScopedUsers(user);
    const target = scoped.find((u) => u.id === id);
    if (!target) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }
    // Managers may edit themselves (non-role fields) or strictly lower-ranked users only.
    if (target.id !== user.id && !canManageTarget(user, target)) {
      res
        .status(403)
        .json({ message: "Not authorized to modify this employee" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const organizationalFields = [
      "role",
      "departmentId",
      "supervisorId",
      "isActive",
    ];
    if (
      target.id === user.id &&
      organizationalFields.some((field) => field in body)
    ) {
      res
        .status(403)
        .json({
          message: "You cannot change your own role or organizational scope",
        });
      return;
    }
    if (
      !ADMIN_ROLES.includes(user.role) &&
      organizationalFields.some((field) => field in body)
    ) {
      res
        .status(403)
        .json({
          message: "Only administrators may change organizational fields",
        });
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const f of ["name", "nameAr", "jobTitle", "jobTitleAr", "phone"]) {
      if (typeof body[f] === "string") patch[f] = body[f];
    }
    if (
      typeof body.role === "string" &&
      USER_ROLES.includes(body.role as User["role"])
    ) {
      const newRole = body.role as User["role"];
      if (newRole !== target.role) {
        if (target.id === user.id) {
          res.status(403).json({ message: "You cannot change your own role" });
          return;
        }
        if (!canAssignRole(user, newRole)) {
          res
            .status(403)
            .json({ message: "You are not allowed to assign this role" });
          return;
        }
        patch.role = newRole;
      }
    }
    if ("departmentId" in body) {
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
      if (departmentId != null) {
        const department = await db
          .select({ id: departmentsTable.id })
          .from(departmentsTable)
          .where(
            and(
              eq(departmentsTable.id, departmentId),
              eq(departmentsTable.facilityId, target.facilityId),
            ),
          );
        if (department.length === 0) {
          res
            .status(400)
            .json({ message: "Department not found in the employee facility" });
          return;
        }
      }
      patch.departmentId = departmentId;
    }
    if ("supervisorId" in body) {
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
      if (supervisorId === target.id) {
        res
          .status(400)
          .json({ message: "An employee cannot supervise themselves" });
        return;
      }
      if (supervisorId != null) {
        const supervisor = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            and(
              eq(usersTable.id, supervisorId),
              eq(usersTable.facilityId, target.facilityId),
            ),
          );
        if (supervisor.length === 0) {
          res
            .status(400)
            .json({ message: "Supervisor not found in the employee facility" });
          return;
        }
      }
      patch.supervisorId = supervisorId;
    }
    if (typeof body.isActive === "boolean") {
      patch.isActive = body.isActive;
      // Revoke unconditionally when an administrator submits an account-state
      // change. This is safe for idempotent retries and closes stale-write races.
      patch.sessionVersion = sql`${usersTable.sessionVersion} + 1`;
    }
    const updated = await db
      .update(usersTable)
      .set(patch)
      .where(eq(usersTable.id, id))
      .returning();
    const result = updated[0];
    if (!result) {
      res.status(500).json({ message: "Update failed" });
      return;
    }
    await logAudit(
      user,
      "Updated employee",
      "تحديث موظف",
      result.name,
      result.nameAr,
      undefined,
      req.ip,
      result.facilityId,
    );
    res.json(serializeUser(result));
  },
);

router.delete(
  "/employees/:id",
  requireRole(...ADMIN_ROLES),
  async (req, res) => {
    const user = getUser(req);
    const id = Number(req.params.id);
    if (id === user.id) {
      res.status(400).json({ message: "Cannot delete your own account" });
      return;
    }
    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, id));
    const target = rows[0];
    if (
      !target ||
      (user.role !== "system_admin" && target.facilityId !== user.facilityId)
    ) {
      res.status(404).json({ message: "Employee not found" });
      return;
    }
    if (!canManageTarget(user, target)) {
      res
        .status(403)
        .json({ message: "Not authorized to delete this employee" });
      return;
    }
    // Credential and audit history are regulated records. A DELETE request is
    // therefore implemented as a reversible deactivation and session revocation.
    await db
      .update(usersTable)
      .set({
        isActive: false,
        sessionVersion: sql`${usersTable.sessionVersion} + 1`,
      })
      .where(eq(usersTable.id, id));
    await logAudit(
      user,
      "Deactivated employee",
      "إيقاف موظف",
      target.name,
      target.nameAr,
      undefined,
      req.ip,
      target.facilityId,
    );
    res.status(204).end();
  },
);

async function setActive(
  req: Request,
  res: Response,
  isActive: boolean,
): Promise<void> {
  const user = getUser(req);
  const id = Number((req.params as Record<string, string>).id);
  const scoped = await getScopedUsers(user);
  const target = scoped.find((u) => u.id === id);
  if (!target) {
    res.status(404).json({ message: "Employee not found" });
    return;
  }
  if (target.id === user.id) {
    res
      .status(400)
      .json({ message: "Cannot change activation of your own account" });
    return;
  }
  if (!canManageTarget(user, target)) {
    res.status(403).json({ message: "Not authorized to modify this employee" });
    return;
  }
  const updated = await db
    .update(usersTable)
    .set({
      isActive,
      // Activation must revoke old tokens too; inactive accounts may still
      // have an otherwise-valid JWT that must not revive after reactivation.
      sessionVersion: sql`${usersTable.sessionVersion} + 1`,
    })
    .where(eq(usersTable.id, id))
    .returning();
  const result = updated[0];
  if (!result) {
    res.status(500).json({ message: "Update failed" });
    return;
  }
  await logAudit(
    user,
    isActive ? "Activated employee" : "Deactivated employee",
    isActive ? "تفعيل موظف" : "إيقاف موظف",
    result.name,
    result.nameAr,
    undefined,
    req.ip,
    result.facilityId,
  );
  res.json(serializeUser(result));
}

router.post(
  "/employees/:id/activate",
  requireRole(...MANAGER_ROLES),
  (req, res) => setActive(req, res, true),
);
router.post(
  "/employees/:id/deactivate",
  requireRole(...MANAGER_ROLES),
  (req, res) => setActive(req, res, false),
);

export default router;
