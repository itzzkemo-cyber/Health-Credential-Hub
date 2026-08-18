import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { syncExpiryNotifications } from "../helpers";
import { dispatchPendingExpiryEmails, sendWeeklyDigests } from "./dispatch";

const HOURLY = 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * 3600_000; // Asia/Riyadh is UTC+3 year-round

let running = false;

/**
 * Hourly background job:
 * 1. Generates expiry notifications for ALL active users (not just those who
 *    log in — email alerts must fire even for inactive-in-app staff).
 * 2. Emails any notification never attempted before (ledger-idempotent).
 * 3. On Sundays from 07:00 Riyadh time, sends the weekly supervisor digests
 *    (per-manager weekly gate lives in the ledger).
 */
export function startEmailScheduler(): void {
  if (process.env["EMAIL_ALERTS_DISABLED"] === "1") {
    logger.warn("EMAIL_ALERTS_DISABLED=1 — email scheduler not started");
    return;
  }
  setTimeout(() => void tick(), 15_000).unref();
  setInterval(() => void tick(), HOURLY).unref();
  logger.info("Email scheduler started (hourly)");
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await syncAllUsersNotifications();
    await dispatchPendingExpiryEmails();
    if (isRiyadhSundayMorningOrLater()) {
      await sendWeeklyDigests();
    }
  } catch (err) {
    logger.error({ err }, "Email scheduler tick failed");
  } finally {
    running = false;
  }
}

async function syncAllUsersNotifications(): Promise<void> {
  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.isActive, true));
  for (const user of users) {
    try {
      await syncExpiryNotifications(user);
    } catch (err) {
      logger.error({ err, userId: user.id }, "Notification sync failed");
    }
  }
}

function isRiyadhSundayMorningOrLater(): boolean {
  const riyadh = new Date(Date.now() + RIYADH_OFFSET_MS);
  return riyadh.getUTCDay() === 0 && riyadh.getUTCHours() >= 7;
}
