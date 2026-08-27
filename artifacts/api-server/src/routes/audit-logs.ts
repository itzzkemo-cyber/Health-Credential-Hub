import { Router, type IRouter } from "express";
import { db, auditLogsTable } from "@workspace/db";
import { ListAuditLogsQueryParams } from "@workspace/api-zod";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { requireAuth, requireRole, getUser, ADMIN_ROLES } from "../lib/auth";

const router: IRouter = Router();

router.use("/audit-logs", requireAuth);

router.get("/audit-logs", requireRole(...ADMIN_ROLES), async (req, res) => {
  const current = getUser(req);
  const parsed = ListAuditLogsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid audit log query" });
    return;
  }
  const { userId, dateFrom, dateTo } = parsed.data;
  const action = parsed.data.action?.trim();
  const page = parsed.data.page;
  const pageSize = parsed.data.pageSize;
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 200 ||
    (userId != null && (!Number.isInteger(userId) || userId < 1)) ||
    (action?.length ?? 0) > 200
  ) {
    res.status(400).json({ error: "Invalid audit log query" });
    return;
  }

  const parseDate = (value: string | undefined): Date | null => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
      ? null
      : date;
  };
  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);
  if ((dateFrom && !from) || (dateTo && !to) || (from && to && from > to)) {
    res.status(400).json({ error: "Invalid audit log date range" });
    return;
  }

  const conditions: SQL[] = [];
  if (current.role !== "system_admin") {
    conditions.push(eq(auditLogsTable.facilityId, current.facilityId));
  }
  if (userId != null) conditions.push(eq(auditLogsTable.userId, userId));
  if (action) {
    const escaped = action.replace(/[\\%_]/g, "\\$&");
    const actionSearch = or(
      ilike(auditLogsTable.action, `%${escaped}%`),
      ilike(auditLogsTable.actionAr, `%${escaped}%`),
    );
    if (actionSearch) conditions.push(actionSearch);
  }
  if (from) conditions.push(gte(auditLogsTable.createdAt, from));
  if (to) {
    const exclusiveEnd = new Date(to);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    conditions.push(lt(auditLogsTable.createdAt, exclusiveEnd));
  }
  const where = and(...conditions);

  const [totalRows, rows] = await Promise.all([
    db.select({ total: count() }).from(auditLogsTable).where(where),
    db
      .select()
      .from(auditLogsTable)
      .where(where)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);
  const total = Number(totalRows[0]?.total ?? 0);

  res.json({
    data: rows.map((r) => ({
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
