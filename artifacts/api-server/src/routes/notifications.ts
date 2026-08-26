import { Router, type IRouter } from "express";
import { db, notificationsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import { syncExpiryNotifications } from "../lib/helpers";
import { dispatchPendingExpiryEmails } from "../lib/email/dispatch";
import { logger } from "../lib/logger";
import { safeErrorLogFields } from "../lib/safeError";

const router: IRouter = Router();

// On-activity email dispatch, throttled — the hourly scheduler is the
// backstop; this just shortens the delay when someone is actively using
// the app right after a new expiry notification appears.
let lastDispatchAt = 0;
function dispatchThrottled(): void {
  if (Date.now() - lastDispatchAt < 5 * 60_000) return;
  lastDispatchAt = Date.now();
  void dispatchPendingExpiryEmails().catch((err) =>
    logger.error(
      safeErrorLogFields(err),
      "On-activity email dispatch failed",
    ),
  );
}

router.use("/notifications", requireAuth);

function serialize(n: typeof notificationsTable.$inferSelect) {
  return {
    id: n.id,
    userId: n.userId,
    type: n.type,
    titleAr: n.titleAr,
    titleEn: n.titleEn,
    messageAr: n.messageAr,
    messageEn: n.messageEn,
    credentialId: n.credentialId,
    employeeId: n.employeeId,
    isRead: n.isRead,
    daysUntilExpiry: n.daysUntilExpiry,
    createdAt: n.createdAt.toISOString(),
  };
}

router.get("/notifications", async (req, res) => {
  const user = getUser(req);
  await syncExpiryNotifications(user);
  dispatchThrottled();
  const unreadOnly = req.query.unreadOnly === "true";
  const rows = await db
    .select()
    .from(notificationsTable)
    .where(
      unreadOnly
        ? and(
            eq(notificationsTable.userId, user.id),
            eq(notificationsTable.isRead, false),
          )
        : eq(notificationsTable.userId, user.id),
    )
    .orderBy(desc(notificationsTable.createdAt))
    .limit(100);
  res.json(rows.map(serialize));
});

router.get("/notifications/unread-count", async (req, res) => {
  const user = getUser(req);
  const rows = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, user.id),
        eq(notificationsTable.isRead, false),
      ),
    );
  res.json({ count: rows.length });
});

router.post("/notifications/mark-all-read", async (req, res) => {
  const user = getUser(req);
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(eq(notificationsTable.userId, user.id));
  res.json({});
});

router.post("/notifications/:id/read", async (req, res) => {
  const user = getUser(req);
  const id = Number(req.params.id);
  await db
    .update(notificationsTable)
    .set({ isRead: true })
    .where(
      and(eq(notificationsTable.id, id), eq(notificationsTable.userId, user.id)),
    );
  res.json({});
});

export default router;
