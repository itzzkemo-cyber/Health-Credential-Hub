import { Router, type IRouter } from "express";
import {
  db,
  credentialPoliciesTable,
  departmentsTable,
  CREDENTIAL_TYPES,
  USER_ROLES,
  type CredentialType,
  type UserRole,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth, requireRole, getUser, ADMIN_ROLES } from "../lib/auth";
import { logAudit } from "../lib/helpers";

const router: IRouter = Router();

router.use("/policies", requireAuth);

function serialize(p: typeof credentialPoliciesTable.$inferSelect) {
  return {
    id: p.id,
    credentialType: p.credentialType,
    departmentId: p.departmentId,
    roles: p.roles ?? [],
    isRequired: p.isRequired,
    createdAt: p.createdAt.toISOString(),
  };
}

router.get("/policies", async (req, res) => {
  const user = getUser(req);
  const rows = await db
    .select()
    .from(credentialPoliciesTable)
    .where(eq(credentialPoliciesTable.facilityId, user.facilityId));
  res.json(rows.map(serialize));
});

router.post("/policies", requireRole(...ADMIN_ROLES), async (req, res) => {
  const user = getUser(req);
  const { credentialType, departmentId, roles, isRequired } = req.body as {
    credentialType?: string;
    departmentId?: number | null;
    roles?: string[];
    isRequired?: boolean;
  };
  if (!credentialType || !CREDENTIAL_TYPES.includes(credentialType as CredentialType)) {
    res.status(400).json({ message: "Invalid credentialType" });
    return;
  }
  if (isRequired !== undefined && typeof isRequired !== "boolean") {
    res.status(400).json({ message: "isRequired must be a boolean" });
    return;
  }
  const normalizedDepartmentId =
    departmentId == null ? null : Number(departmentId);
  if (
    normalizedDepartmentId != null &&
    (!Number.isSafeInteger(normalizedDepartmentId) ||
      normalizedDepartmentId < 1)
  ) {
    res.status(400).json({ message: "Invalid departmentId" });
    return;
  }
  if (normalizedDepartmentId != null) {
    const department = await db
      .select({ id: departmentsTable.id })
      .from(departmentsTable)
      .where(
        and(
          eq(departmentsTable.id, normalizedDepartmentId),
          eq(departmentsTable.facilityId, user.facilityId),
        ),
      );
    if (department.length !== 1) {
      res.status(400).json({ message: "Department not found in this facility" });
      return;
    }
  }
  const normalizedRoles = Array.isArray(roles) ? roles : [];
  if (
    !normalizedRoles.every(
      (role): role is UserRole =>
        typeof role === "string" &&
        USER_ROLES.includes(role as UserRole),
    )
  ) {
    res.status(400).json({ message: "Invalid policy role" });
    return;
  }
  const inserted = await db
    .insert(credentialPoliciesTable)
    .values({
      facilityId: user.facilityId,
      credentialType,
      departmentId: normalizedDepartmentId,
      roles: normalizedRoles,
      isRequired: isRequired ?? true,
    })
    .returning();
  const policy = inserted[0];
  if (!policy) {
    res.status(500).json({ message: "Insert failed" });
    return;
  }
  await logAudit(
    user,
    "Created policy",
    "إنشاء سياسة",
    `Requirement: ${credentialType}`,
    `اشتراط: ${credentialType}`,
    undefined,
    req.ip,
  );
  res.status(201).json(serialize(policy));
});

router.delete("/policies/:id", requireRole(...ADMIN_ROLES), async (req, res) => {
  const user = getUser(req);
  const id = Number(req.params.id);
  const rows = await db
    .select()
    .from(credentialPoliciesTable)
    .where(eq(credentialPoliciesTable.id, id));
  const policy = rows[0];
  if (!policy || policy.facilityId !== user.facilityId) {
    res.status(404).json({ message: "Policy not found" });
    return;
  }
  await db.delete(credentialPoliciesTable).where(eq(credentialPoliciesTable.id, id));
  await logAudit(
    user,
    "Deleted policy",
    "حذف سياسة",
    `Requirement: ${policy.credentialType}`,
    `اشتراط: ${policy.credentialType}`,
    undefined,
    req.ip,
  );
  res.status(204).end();
});

export default router;
