import {
  automationDeliveryLogTable,
  automationOutboxTable,
  credentialsTable,
  db,
  usersTable,
  type AutomationOutboxRow,
} from "@workspace/db";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { logger } from "../logger";
import { daysUntil } from "../helpers";
import type { AutomationConfig } from "./config";
import {
  credentialExpiryDueEvent,
  expiryThresholdFor,
  retryBackoffMs,
} from "./events";
import { buildAutomationEnvelope, deliverAutomationWebhook } from "./webhook";

interface ClaimedOutboxRow extends AutomationOutboxRow {
  lockedAt: Date;
}

async function enqueueExpiryDueEvents(config: AutomationConfig): Promise<void> {
  const rows = await db
    .select({ credential: credentialsTable, facilityId: usersTable.facilityId })
    .from(credentialsTable)
    .innerJoin(usersTable, eq(credentialsTable.employeeId, usersTable.id))
    .where(
      and(
        isNull(credentialsTable.deletedAt),
        eq(usersTable.isActive, true),
        inArray(usersTable.facilityId, [...config.facilityAllowlist]),
      ),
    );

  for (const { credential, facilityId } of rows) {
    const dueInDays = daysUntil(credential.expiryDate);
    const threshold = expiryThresholdFor(dueInDays);
    if (threshold == null) continue;
    await db
      .insert(automationOutboxTable)
      .values(
        credentialExpiryDueEvent(credential, facilityId, dueInDays, threshold),
      )
      .onConflictDoNothing();
  }
}

async function retireStaleClaims(config: AutomationConfig): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - config.lockTimeoutMs);
  // A worker can crash after consuming the final attempt but before marking
  // the row. Retire those stale claims explicitly so they never remain stuck.
  await db.transaction(async (tx) => {
    const retired = await tx
      .update(automationOutboxTable)
      .set({
        lockedAt: null,
        discardedAt: now,
        lastErrorCode: "claim_expired_after_max_attempts",
      })
      .where(
        and(
          isNull(automationOutboxTable.processedAt),
          isNull(automationOutboxTable.discardedAt),
          isNotNull(automationOutboxTable.lockedAt),
          lt(automationOutboxTable.lockedAt, staleBefore),
          gte(automationOutboxTable.attempts, config.maxAttempts),
        ),
      )
      .returning();
    if (retired.length > 0) {
      await tx
        .insert(automationDeliveryLogTable)
        .values(
          retired.map((row) => ({
            eventId: row.id,
            facilityId: row.facilityId,
            eventType: row.eventType,
            status: "discarded" as const,
            attempts: row.attempts,
            lastErrorCode: "claim_expired_after_max_attempts",
            recordedAt: now,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

async function discardStalePending(config: AutomationConfig): Promise<void> {
  const now = new Date();
  const pendingBefore = new Date(
    now.getTime() - config.pendingMaxAgeDays * 86_400_000,
  );
  const staleLockBefore = new Date(now.getTime() - config.lockTimeoutMs);
  await db.transaction(async (tx) => {
    const discarded = await tx
      .update(automationOutboxTable)
      .set({
        lockedAt: null,
        discardedAt: now,
        lastErrorCode: "stale_pending",
      })
      .where(
        and(
          isNull(automationOutboxTable.processedAt),
          isNull(automationOutboxTable.discardedAt),
          lt(automationOutboxTable.createdAt, pendingBefore),
          or(
            isNull(automationOutboxTable.lockedAt),
            lt(automationOutboxTable.lockedAt, staleLockBefore),
          ),
        ),
      )
      .returning();
    if (discarded.length > 0) {
      await tx
        .insert(automationDeliveryLogTable)
        .values(
          discarded.map((row) => ({
            eventId: row.id,
            facilityId: row.facilityId,
            eventType: row.eventType,
            status: "discarded" as const,
            attempts: row.attempts,
            lastErrorCode: "stale_pending",
            recordedAt: now,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

/** Claim only immediately before delivery so a batch never shares one TTL. */
async function claimNext(
  config: AutomationConfig,
): Promise<ClaimedOutboxRow | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - config.lockTimeoutMs);
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(automationOutboxTable)
        .where(
          and(
            isNull(automationOutboxTable.processedAt),
            isNull(automationOutboxTable.discardedAt),
            lte(automationOutboxTable.availableAt, now),
            or(
              isNull(automationOutboxTable.lockedAt),
              lt(automationOutboxTable.lockedAt, staleBefore),
            ),
            lt(automationOutboxTable.attempts, config.maxAttempts),
            inArray(automationOutboxTable.facilityId, [
              ...config.facilityAllowlist,
            ]),
          ),
        )
        .orderBy(
          asc(automationOutboxTable.availableAt),
          asc(automationOutboxTable.createdAt),
        )
        .limit(1)
        .for("update", { skipLocked: true })
    )[0];
    if (!row) return null;
    const updated = (
      await tx
        .update(automationOutboxTable)
        .set({
          lockedAt: now,
          attempts: sql`${automationOutboxTable.attempts} + 1`,
          lastErrorCode: null,
        })
        .where(eq(automationOutboxTable.id, row.id))
        .returning()
    )[0];
    return updated?.lockedAt ? (updated as ClaimedOutboxRow) : null;
  });
}

async function remainsDeliverable(
  row: ClaimedOutboxRow,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const current = (
    await db
      .select({
        credentialType: credentialsTable.type,
        deletedAt: credentialsTable.deletedAt,
        employeeId: credentialsTable.employeeId,
        expiryDate: credentialsTable.expiryDate,
        isVerified: credentialsTable.isVerified,
        facilityId: usersTable.facilityId,
        employeeActive: usersTable.isActive,
      })
      .from(credentialsTable)
      .innerJoin(usersTable, eq(credentialsTable.employeeId, usersTable.id))
      .where(eq(credentialsTable.id, row.credentialId))
      .limit(1)
  )[0];
  if (
    !current ||
    current.deletedAt != null ||
    !current.employeeActive ||
    current.facilityId !== row.facilityId
  ) {
    return false;
  }
  if (
    row.credentialId !== payload.credentialId ||
    current.employeeId !== payload.employeeId ||
    current.credentialType !== payload.credentialType
  ) {
    return false;
  }
  if (
    row.eventType === "credential.verification_changed" &&
    current.isVerified !== payload.isVerified
  ) {
    return false;
  }
  if (
    row.eventType === "credential.expiry_due" &&
    current.expiryDate !== payload.expiryDate
  ) {
    return false;
  }
  return true;
}

async function markDelivered(row: ClaimedOutboxRow): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const delivered = (
      await tx
        .update(automationOutboxTable)
        .set({ processedAt: now, lockedAt: null, lastErrorCode: null })
        .where(
          and(
            eq(automationOutboxTable.id, row.id),
            eq(automationOutboxTable.lockedAt, row.lockedAt),
            isNull(automationOutboxTable.processedAt),
            isNull(automationOutboxTable.discardedAt),
          ),
        )
        .returning({ id: automationOutboxTable.id })
    )[0];
    if (!delivered) return;
    await tx
      .insert(automationDeliveryLogTable)
      .values({
        eventId: row.id,
        facilityId: row.facilityId,
        eventType: row.eventType,
        status: "delivered",
        attempts: row.attempts,
        lastErrorCode: null,
        recordedAt: now,
      })
      .onConflictDoNothing();
  });
}

async function markFailed(
  row: ClaimedOutboxRow,
  config: AutomationConfig,
  errorCode: string,
  permanent = false,
  retryDelayMs?: number,
): Promise<void> {
  const exhausted = permanent || row.attempts >= config.maxAttempts;
  const now = new Date();
  const safeErrorCode = errorCode.slice(0, 80);
  await db.transaction(async (tx) => {
    const updated = (
      await tx
        .update(automationOutboxTable)
        .set({
          lockedAt: null,
          lastErrorCode: safeErrorCode,
          ...(exhausted
            ? { discardedAt: now }
            : {
                availableAt: new Date(
                  now.getTime() +
                    (retryDelayMs ?? retryBackoffMs(row.attempts)),
                ),
              }),
        })
        .where(
          and(
            eq(automationOutboxTable.id, row.id),
            eq(automationOutboxTable.lockedAt, row.lockedAt),
            isNull(automationOutboxTable.processedAt),
            isNull(automationOutboxTable.discardedAt),
          ),
        )
        .returning({ id: automationOutboxTable.id })
    )[0];
    if (!updated || !exhausted) return;
    await tx
      .insert(automationDeliveryLogTable)
      .values({
        eventId: row.id,
        facilityId: row.facilityId,
        eventType: row.eventType,
        status: "discarded",
        attempts: row.attempts,
        lastErrorCode: safeErrorCode,
        recordedAt: now,
      })
      .onConflictDoNothing();
  });
}

async function cleanupOutbox(config: AutomationConfig): Promise<void> {
  const before = new Date(Date.now() - config.retentionDays * 86_400_000);
  await db
    .delete(automationOutboxTable)
    .where(
      or(
        and(
          isNotNull(automationOutboxTable.processedAt),
          lt(automationOutboxTable.processedAt, before),
        ),
        and(
          isNotNull(automationOutboxTable.discardedAt),
          lt(automationOutboxTable.discardedAt, before),
        ),
      ),
    );
}

export async function runAutomationWorkerCycle(
  config: AutomationConfig,
): Promise<number> {
  if (!config.enabled) return 0;
  await enqueueExpiryDueEvents(config);
  await retireStaleClaims(config);
  await discardStalePending(config);
  let claimedCount = 0;
  for (let index = 0; index < config.batchSize; index += 1) {
    const row = await claimNext(config);
    if (!row) break;
    claimedCount += 1;
    const envelope = buildAutomationEnvelope(row);
    if (!envelope) {
      await markFailed(row, config, "invalid_payload", true);
      logger.error(
        {
          eventId: row.id,
          eventType: row.eventType,
          facilityId: row.facilityId,
        },
        "Automation event discarded because its payload failed validation",
      );
      continue;
    }
    if (!(await remainsDeliverable(row, envelope.data))) {
      await markFailed(row, config, "credential_no_longer_deliverable", true);
      logger.warn(
        {
          eventId: row.id,
          eventType: row.eventType,
          facilityId: row.facilityId,
        },
        "Automation event discarded because credential scope/state changed",
      );
      continue;
    }
    const result = await deliverAutomationWebhook(envelope, config);
    if (result.ok) {
      await markDelivered(row);
      logger.info(
        {
          eventId: row.id,
          eventType: row.eventType,
          facilityId: row.facilityId,
        },
        "Automation event delivered",
      );
    } else {
      await markFailed(
        row,
        config,
        result.errorCode,
        result.permanent,
        result.retryAfterMs,
      );
      logger.warn(
        {
          eventId: row.id,
          eventType: row.eventType,
          facilityId: row.facilityId,
          attempt: row.attempts,
          errorCode: result.errorCode,
        },
        "Automation event delivery failed",
      );
    }
  }
  await cleanupOutbox(config);
  return claimedCount;
}

export async function runAutomationWorkerContinuously(
  config: AutomationConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await runAutomationWorkerCycle(config);
    } catch (error) {
      logger.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Automation worker cycle failed",
      );
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.pollIntervalMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
