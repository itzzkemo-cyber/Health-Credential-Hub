import { Router, type IRouter } from "express";
import { db, auditLogsTable, usersTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireAuth, requireRole, getUser, ADMIN_ROLES } from "../lib/auth";

const router: IRouter = Router();

router.use("/audit-logs", requireAuth);

router.get("/audit-logs", requireRole(...ADMIN_ROLES), async (req, res) => {
  const current = getUser(req);
  const { userId, action, dateFrom, dateTo } = req.query as Record<
    string,
    string | undefined
  >;
  let rows;
  if (current.role === "system_admin") {
    rows = await db
      .select()
      .from(auditLogsTable)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(2000);
  } else {
    const scopedRows = await db
      .select({ audit: auditLogsTable })
      .from(auditLogsTable)
      .innerJoin(usersTable, eq(auditLogsTable.userId, usersTable.id))
      .where(eq(usersTable.facilityId, current.facilityId))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(2000);
    rows = scopedRows.map(({ audit }) => audit);
  }

  if (userId) rows = rows.filter((r) => r.userId === Number(userId));
  if (action) {
    const q = action.toLowerCase();
    rows = rows.filter(
      (r) => r.action.toLowerCase().includes(q) || r.actionAr.includes(action),
    );
  }
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00Z`).getTime();
    rows = rows.filter((r) => r.createdAt.getTime() >= from);
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59Z`).getTime();
    rows = rows.filter((r) => r.createdAt.getTime() <= to);
  }

  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)));
  const total = rows.length;
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);

  res.json({
    data: slice.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      userNameAr: r.userNameAr,
      action: r.action,
      actionAr: r.actionAr,
      target: r.target,
      targetAr: r.targetAr,
      details: r.details,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  });
});

export default router;
