import { Router, type IRouter } from "express";
import { db, auditLogsTable } from "@workspace/db";
import { desc, inArray } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import {
  getScopedUsers,
  getCredentialsFor,
  getPolicies,
  getDepartments,
  computeEmployeeStats,
  computeStatus,
  daysUntil,
  serializeCredential,
} from "../lib/helpers";

const router: IRouter = Router();

router.use("/dashboard", requireAuth);

async function recentActivityFor(userIds: number[], limit: number) {
  if (userIds.length === 0) return [];
  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(inArray(auditLogsTable.userId, userIds))
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actionAr: r.actionAr,
    actor: r.userName,
    actorAr: r.userNameAr,
    target: r.target,
    targetAr: r.targetAr,
    createdAt: r.createdAt.toISOString(),
  }));
}

router.get("/dashboard/stats", async (req, res) => {
  const user = getUser(req);
  const scoped = (await getScopedUsers(user)).filter((u) => u.isActive);
  const byId = new Map(scoped.map((u) => [u.id, u]));
  const creds = await getCredentialsFor(scoped.map((u) => u.id));
  const policies = await getPolicies(user.role === "system_admin" ? null : user.facilityId);

  let missingCredentials = 0;
  let atRiskEmployees = 0;
  let complianceRateSum = 0;
  for (const u of scoped) {
    const s = computeEmployeeStats(u, creds, policies);
    missingCredentials += s.missingCount;
    if (s.isAtRisk) atRiskEmployees += 1;
    complianceRateSum += s.complianceRate;
  }
  const expiredCredentials = creds.filter(
    (c) => computeStatus(c.expiryDate) === "expired",
  ).length;
  const expiringCredentials = creds.filter(
    (c) => computeStatus(c.expiryDate) === "expiring_soon",
  ).length;
  const complianceRate =
    scoped.length === 0 ? 100 : Math.round(complianceRateSum / scoped.length);

  const upcoming = creds
    .filter((c) => {
      const d = daysUntil(c.expiryDate);
      return d >= 0 && d <= 120;
    })
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
    .slice(0, 8)
    .map((c) => serializeCredential(c, byId.get(c.employeeId)));

  res.json({
    totalCredentials: creds.length,
    activeCredentials: creds.filter((c) => computeStatus(c.expiryDate) === "active").length,
    expiringCredentials,
    expiredCredentials,
    missingCredentials,
    complianceRate,
    totalEmployees: scoped.length,
    atRiskEmployees,
    upcomingExpirations: upcoming,
    recentActivity: await recentActivityFor(
      scoped.map((u) => u.id),
      10,
    ),
  });
});

router.get("/dashboard/compliance", async (req, res) => {
  const user = getUser(req);
  const scoped = (await getScopedUsers(user)).filter((u) => u.isActive);
  const creds = await getCredentialsFor(scoped.map((u) => u.id));
  const policies = await getPolicies(user.role === "system_admin" ? null : user.facilityId);
  const departments = await getDepartments(user.role === "system_admin" ? null : user.facilityId);

  const visibleDeptIds = new Set(
    scoped.filter((u) => u.departmentId != null).map((u) => u.departmentId as number),
  );
  const visibleDepts = departments.filter((d) => visibleDeptIds.has(d.id));

  const result = visibleDepts.map((d) => {
    const members = scoped.filter((u) => u.departmentId === d.id);
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
      departmentId: d.id,
      departmentName: d.name,
      departmentNameAr: d.nameAr,
      complianceRate: members.length === 0 ? 100 : Math.round(rateSum / members.length),
      employeeCount: members.length,
      expiredCount,
      expiringCount,
    };
  });
  result.sort((a, b) => a.complianceRate - b.complianceRate);
  res.json(result);
});

router.get("/dashboard/activity", async (req, res) => {
  const user = getUser(req);
  const scoped = await getScopedUsers(user);
  res.json(
    await recentActivityFor(
      scoped.map((u) => u.id),
      20,
    ),
  );
});

export default router;
