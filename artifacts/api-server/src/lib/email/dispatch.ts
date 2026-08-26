import {
  db,
  usersTable,
  notificationsTable,
  credentialsTable,
  emailLogTable,
  type User,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { logger } from "../logger";
import { safeErrorLogFields } from "../safeError";
import {
  computeEmployeeStats,
  getCredentialsFor,
  getPolicies,
} from "../helpers";
import {
  EmailNotConfiguredError,
  isEmailConfigured,
  isFixtureRecipient,
  sendEmail,
} from "./sender";
import {
  expiryAlertEmail,
  weeklyDigestEmail,
  type DigestMember,
} from "./templates";

const DIGEST_MIN_INTERVAL_MS = 6 * 86_400_000; // ~6 days: one digest per week

/**
 * Send an email for every expiry notification that has never been attempted.
 * The email_log table is the idempotency ledger: one attempt per notification,
 * success or failure — failures stay visible in the ledger, no auto-retries.
 */
export async function dispatchPendingExpiryEmails(): Promise<void> {
  if (!isEmailConfigured()) {
    logger.warn(
      "Email provider not configured — expiry alert emails are pending",
    );
    return;
  }

  const pending = await db
    .select({
      n: notificationsTable,
      u: usersTable,
      credExpiryDate: credentialsTable.expiryDate,
    })
    .from(notificationsTable)
    .innerJoin(usersTable, eq(notificationsTable.userId, usersTable.id))
    .innerJoin(
      credentialsTable,
      and(
        eq(notificationsTable.credentialId, credentialsTable.id),
        isNull(credentialsTable.deletedAt),
      ),
    )
    .where(
      and(
        inArray(notificationsTable.type, ["expiry_warning", "expired"]),
        eq(usersTable.isActive, true),
        notExists(
          db
            .select({ one: sql`1` })
            .from(emailLogTable)
            .where(eq(emailLogTable.notificationId, notificationsTable.id)),
        ),
      ),
    )
    .limit(200);

  if (pending.length === 0) return;
  logger.info({ count: pending.length }, "Dispatching expiry alert emails");

  for (const { n, u, credExpiryDate } of pending) {
    const subject = `${n.titleAr} — ${n.titleEn}`;
    const html = expiryAlertEmail({
      titleAr: n.titleAr,
      titleEn: n.titleEn,
      messageAr: n.messageAr,
      messageEn: n.messageEn,
      expiryDate: credExpiryDate ?? "",
      daysUntilExpiry: n.daysUntilExpiry,
    });
    await attemptSend({
      userId: u.id,
      notificationId: n.id,
      kind: "expiry_alert",
      weekKey: null,
      recipient: u.email,
      subject,
      html,
    });
  }
}

/**
 * Weekly digest for supervisors and department managers listing team members
 * with expired / expiring / missing credentials. Gated per manager by the
 * most recent successful digest in the ledger (~once per week).
 */
export async function sendWeeklyDigests(): Promise<void> {
  if (!isEmailConfigured()) return;

  const managers = await db
    .select()
    .from(usersTable)
    .where(
      and(
        inArray(usersTable.role, ["supervisor", "department_manager"]),
        eq(usersTable.isActive, true),
      ),
    );

  for (const manager of managers) {
    const [lastSent] = await db
      .select({ createdAt: emailLogTable.createdAt })
      .from(emailLogTable)
      .where(
        and(
          eq(emailLogTable.userId, manager.id),
          eq(emailLogTable.kind, "weekly_digest"),
          eq(emailLogTable.status, "sent"),
        ),
      )
      .orderBy(desc(emailLogTable.createdAt))
      .limit(1);
    if (
      lastSent &&
      Date.now() - lastSent.createdAt.getTime() < DIGEST_MIN_INTERVAL_MS
    ) {
      continue;
    }

    const team = await getTeamMembers(manager);
    if (team.length === 0) continue;

    const [policies, creds] = await Promise.all([
      getPolicies(manager.facilityId),
      getCredentialsFor(team.map((m) => m.id)),
    ]);

    const atRisk: DigestMember[] = [];
    for (const member of team) {
      const stats = computeEmployeeStats(member, creds, policies);
      if (
        stats.expiredCount > 0 ||
        stats.expiringCount > 0 ||
        stats.missingCount > 0
      ) {
        atRisk.push({
          name: member.name,
          nameAr: member.nameAr,
          expiredCount: stats.expiredCount,
          expiringCount: stats.expiringCount,
          missingCount: stats.missingCount,
        });
      }
    }
    if (atRisk.length === 0) continue; // all clear — no email this week

    atRisk.sort(
      (a, b) =>
        b.expiredCount + b.missingCount - (a.expiredCount + a.missingCount),
    );
    await attemptSend({
      userId: manager.id,
      notificationId: null,
      kind: "weekly_digest",
      weekKey: riyadhTodayStr(),
      recipient: manager.email,
      subject: "الملخص الأسبوعي لوثائق فريقك — Weekly team compliance digest",
      html: weeklyDigestEmail({
        managerName: manager.name,
        managerNameAr: manager.nameAr,
        members: atRisk,
      }),
    });
  }
}

async function getTeamMembers(manager: User): Promise<User[]> {
  if (manager.role === "supervisor") {
    return db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.supervisorId, manager.id),
          eq(usersTable.facilityId, manager.facilityId),
          eq(usersTable.isActive, true),
        ),
      );
  }
  // department_manager
  if (manager.departmentId == null) return [];
  const rows = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.departmentId, manager.departmentId),
        eq(usersTable.facilityId, manager.facilityId),
        eq(usersTable.isActive, true),
      ),
    );
  return rows.filter((u) => u.id !== manager.id);
}

/** Riyadh (UTC+3) calendar date — digests run Sundays, so this is the week key. */
function riyadhTodayStr(): string {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Claim-first send: insert the ledger row (status `sending`) BEFORE sending,
 * relying on the table's unique indexes (notification_id / user+week_key) so
 * that concurrent dispatchers — hourly tick, on-activity trigger, multiple
 * server instances — can never send the same email twice. Losers of the race
 * get no row back from ON CONFLICT DO NOTHING and simply skip.
 */
async function attemptSend(input: {
  userId: number;
  notificationId: number | null;
  kind: "expiry_alert" | "weekly_digest";
  weekKey: string | null;
  recipient: string;
  subject: string;
  html: string;
}): Promise<void> {
  const claimed = await db
    .insert(emailLogTable)
    .values({
      userId: input.userId,
      notificationId: input.notificationId,
      kind: input.kind,
      weekKey: input.weekKey,
      recipient: input.recipient,
      subject: input.subject,
      status: "sending",
      error: null,
    })
    .onConflictDoNothing()
    .returning({ id: emailLogTable.id });
  const claim = claimed[0];
  if (!claim) return; // another dispatcher already claimed this email

  if (isFixtureRecipient(input.recipient)) {
    await db
      .update(emailLogTable)
      .set({
        status: "skipped",
        error: "Test-only recipient address — real delivery suppressed",
      })
      .where(eq(emailLogTable.id, claim.id));
    logger.info(
      { kind: input.kind, notificationId: input.notificationId },
      "Email skipped — fixture recipient",
    );
    return;
  }

  try {
    await sendEmail({
      to: input.recipient,
      subject: input.subject,
      html: input.html,
    });
    await db
      .update(emailLogTable)
      .set({ status: "sent" })
      .where(eq(emailLogTable.id, claim.id));
    logger.info(
      { kind: input.kind, notificationId: input.notificationId },
      "Email sent",
    );
  } catch (err) {
    // Config/authorization-class failures must NOT consume the one allowed
    // attempt: release the claim so everything stays pending and sends
    // normally once the provider is fixed.
    if (err instanceof EmailNotConfiguredError) {
      await db.delete(emailLogTable).where(eq(emailLogTable.id, claim.id));
      logger.warn(
        { kind: input.kind },
        "Email skipped — provider not configured (kept pending)",
      );
      return;
    }
    const safeFailure = safeErrorLogFields(err);
    const failureClassification = safeFailure.errorCode
      ? `${safeFailure.errorName}:${safeFailure.errorCode}`
      : safeFailure.errorName;
    await db
      .update(emailLogTable)
      .set({ status: "failed", error: failureClassification })
      .where(eq(emailLogTable.id, claim.id));
    logger.error(
      {
        ...safeFailure,
        kind: input.kind,
      },
      "Email send failed",
    );
  }
}
