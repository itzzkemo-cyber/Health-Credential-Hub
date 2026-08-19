import { Router, type IRouter } from "express";
import { db, departmentsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireAuth, requireRole, getUser, ADMIN_ROLES } from "../lib/auth";
import {
  getCredentialsFor,
  getPolicies,
  computeEmployeeStats,
  getScopedUsers,
  logAudit,
} from "../lib/helpers";

const router: IRouter = Router();

async function validateDepartmentHead(
  headId: number | null,
  facilityId: number,
): Promise<boolean> {
  if (headId == null) return true;
  if (!Number.isSafeInteger(headId) || headId < 1) return false;
  const head = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, headId),
        eq(usersTable.facilityId, facilityId),
        eq(usersTable.isActive, true),
      ),
    );
  return head.length === 1;
}

router.use("/departments", requireAuth);

router.get("/departments", async (req, res) => {
  const user = getUser(req);
  const departments = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.facilityId, user.facilityId));
  const scopedUsers = (await getScopedUsers(user)).filter(
    (candidate) => candidate.facilityId === user.facilityId,
  );
  const creds = await getCredentialsFor(scopedUsers.map((u) => u.id));
  const policies = await getPolicies(user.facilityId);

  const result = departments.map((d) => {
    const members = scopedUsers.filter((u) => u.departmentId === d.id && u.isActive);
    let expiredCount = 0;
    let expiringCount = 0;
    let rateSum = 0;
    for (const m of members) {
      const s = computeEmployeeStats(m, creds, policies);
      expiredCount += s.expiredCount;
      expiringCount += s.expiringCount;
      rateSum += s.complianceRate;
    }
    return {
      id: d.id,
      name: d.name,
      nameAr: d.nameAr,
      facilityId: d.facilityId,
      headId: d.headId,
      createdAt: d.createdAt.toISOString(),
      employeeCount: members.length,
      complianceRate: members.length === 0 ? 100 : Math.round(rateSum / members.length),
      expiredCount,
      expiringCount,
    };
  });
  res.json(result);
});

router.post("/departments", requireRole(...ADMIN_ROLES), async (req, res) => {
  const user = getUser(req);
  const { name, nameAr, headId } = req.body as {
    name?: string;
    nameAr?: string;
    headId?: number | null;
  };
  if (!name || !nameAr) {
    res.status(400).json({ message: "name and nameAr are required" });
    return;
  }
  const normalizedHeadId = headId == null ? null : Number(headId);
  if (!(await validateDepartmentHead(normalizedHeadId, user.facilityId))) {
    res.status(400).json({
      message: "Department head not found in this facility",
    });
    return;
  }
  const inserted = await db
    .insert(departmentsTable)
    .values({
      name,
      nameAr,
      facilityId: user.facilityId,
      headId: normalizedHeadId,
    })
    .returning();
  const dept = inserted[0];
  if (!dept) {
    res.status(500).json({ message: "Insert failed" });
    return;
  }
  await logAudit(user, "Created department", "إنشاء قسم", dept.name, dept.nameAr, undefined, req.ip);
  res.status(201).json({
    id: dept.id,
    name: dept.name,
    nameAr: dept.nameAr,
    facilityId: dept.facilityId,
    headId: dept.headId,
    createdAt: dept.createdAt.toISOString(),
  });
});

router.get("/departments/:id", async (req, res) => {
  const user = getUser(req);
  const id = Number(req.params.id);
  const rows = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.id, id));
  const dept = rows[0];
  if (!dept || dept.facilityId !== user.facilityId) {
    res.status(404).json({ message: "Department not found" });
    return;
  }
  res.json({
    id: dept.id,
    name: dept.name,
    nameAr: dept.nameAr,
    facilityId: dept.facilityId,
    headId: dept.headId,
    createdAt: dept.createdAt.toISOString(),
  });
});

router.patch("/departments/:id", requireRole(...ADMIN_ROLES), async (req, res) => {
  const user = getUser(req);
  const id = Number(req.params.id);
  const rows = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.id, id));
  const dept = rows[0];
  if (!dept || dept.facilityId !== user.facilityId) {
    res.status(404).json({ message: "Department not found" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim())
    patch.name = body.name.trim();
  if (typeof body.nameAr === "string" && body.nameAr.trim())
    patch.nameAr = body.nameAr.trim();
  if ("headId" in body) {
    const headId = body.headId == null ? null : Number(body.headId);
    if (!(await validateDepartmentHead(headId, dept.facilityId))) {
      res.status(400).json({
        message: "Department head not found in this facility",
      });
      return;
    }
    patch.headId = headId;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ message: "No valid department fields supplied" });
    return;
  }
  const updated = await db
    .update(departmentsTable)
    .set(patch)
    .where(eq(departmentsTable.id, id))
    .returning();
  const result = updated[0];
  if (!result) {
    res.status(500).json({ message: "Update failed" });
    return;
  }
  await logAudit(user, "Updated department", "تحديث قسم", result.name, result.nameAr, undefined, req.ip);
  res.json({
    id: result.id,
    name: result.name,
    nameAr: result.nameAr,
    facilityId: result.facilityId,
    headId: result.headId,
    createdAt: result.createdAt.toISOString(),
  });
});

router.delete("/departments/:id", requireRole(...ADMIN_ROLES), async (req, res) => {
  const user = getUser(req);
  const id = Number(req.params.id);
  const rows = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.id, id));
  const dept = rows[0];
  if (!dept || dept.facilityId !== user.facilityId) {
    res.status(404).json({ message: "Department not found" });
    return;
  }
  await db
    .update(usersTable)
    .set({ departmentId: null })
    .where(eq(usersTable.departmentId, id));
  await db.delete(departmentsTable).where(eq(departmentsTable.id, id));
  await logAudit(user, "Deleted department", "حذف قسم", dept.name, dept.nameAr, undefined, req.ip);
  res.status(204).end();
});

export default router;
