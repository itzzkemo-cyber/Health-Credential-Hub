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
  desc,
  eq,
  gt,
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
import { safeErrorLogFields } from "../safeError";
import { dateStr, daysUntil } from "../helpers";
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

const EXPIRY_SCAN_BATCH_SIZE = 250;
const EXPIRY_SCAN_INTERVAL_MS = 60 * 60_000;
const MAINTENANCE_BATCH_SIZE = 250;
const MAX_CONSECUTIVE_CYCLE_FAILURES = 5;
const RECEIVER_CONTRACT_RETRY_LIMIT = 3;

class AutomationWorkerUnavailableError extends Error {
  override readonly name = "AutomationWorkerUnavailableError";
}

interface ContinuousAutomationWorkerOptions {
  maxConsecutiveFailures?: number;
  runCycle?: (config: AutomationConfig) => Promise<number>;
}

const receiverAlertErrorCodes = new Set([
  "http_401",
  "http_403",
  "invalid_acknowledgement",
]);

interface ExpiryScanState {
  inFlight?: Promise<void>;
  nextScanAtMs: number;
}

// Continuous workers reuse one validated config object. Keeping cadence state
// against that object avoids a database-wide expiry scan on every short outbox
// poll, while a new process/config still scans immediately and catches up via
// the durable expiry-event deduplication key.
const expiryScanStates = new WeakMap<AutomationConfig, ExpiryScanState>();

async function enqueueExpiryDueEvents(config: AutomationConfig): Promise<void> {
  // Freeze the upper bound for this cycle so a one-shot worker can page through
  // every credential that existed when the scan began without depending on
  // process-local cursor state or chasing concurrently inserted rows forever.
  const snapshot = (
    await db
      .select({ id: credentialsTable.id })
      .from(credentialsTable)
      .innerJoin(usersTable, eq(credentialsTable.employeeId, usersTable.id))
      .where(
        and(
          isNull(credentialsTable.deletedAt),
          eq(usersTable.isActive, true),
          lte(credentialsTable.expiryDate, dateStr(90)),
          inArray(usersTable.facilityId, [...config.facilityAllowlist]),
        ),
      )
      .orderBy(desc(credentialsTable.id))
      .limit(1)
  )[0];
  if (!snapshot) return;

  let cursor = 0;
  while (cursor < snapshot.id) {
    const rows = await db
      .select({
        credential: credentialsTable,
        facilityId: usersTable.facilityId,
      })
      .from(credentialsTable)
      .innerJoin(usersTable, eq(credentialsTable.employeeId, usersTable.id))
      .where(
        and(
          isNull(credentialsTable.deletedAt),
          eq(usersTable.isActive, true),
          lte(credentialsTable.expiryDate, dateStr(90)),
          gt(credentialsTable.id, cursor),
          lte(credentialsTable.id, snapshot.id),
          inArray(usersTable.facilityId, [...config.facilityAllowlist]),
        ),
      )
      .orderBy(asc(credentialsTable.id))
      .limit(EXPIRY_SCAN_BATCH_SIZE);

    for (const { credential, facilityId } of rows) {
      const dueInDays = daysUntil(credential.expiryDate);
      const threshold = expiryThresholdFor(dueInDays);
      if (threshold == null) continue;
      await db
        .insert(automationOutboxTable)
        .values(
          credentialExpiryDueEvent(
            credential,
            facilityId,
            dueInDays,
            threshold,
          ),
        )
        .onConflictDoNothing();
    }

    const lastCredentialId = rows.at(-1)?.credential.id;
    if (lastCredentialId == null || lastCredentialId <= cursor) break;
    cursor = lastCredentialId;
    if (rows.length < EXPIRY_SCAN_BATCH_SIZE) break;
  }
}

async function enqueueExpiryDueEventsIfNeeded(
  config: AutomationConfig,
): Promise<void> {
  let state = expiryScanStates.get(config);
  if (!state) {
    state = { nextScanAtMs: 0 };
    expiryScanStates.set(config, state);
  }

  // Share a scan when overlapping cycles are invoked with the same config.
  // Failed scans do not advance the deadline, so the next worker poll retries.
  if (state.inFlight) return state.inFlight;
  if (Date.now() < state.nextScanAtMs) return;

  const scan = enqueueExpiryDueEvents(config)
    .then(() => {
      state.nextScanAtMs = Date.now() + EXPIRY_SCAN_INTERVAL_MS;
    })
    .finally(() => {
      state.inFlight = undefined;
    });
  state.inFlight = scan;
  return scan;
}

async function retireStaleClaims(config: AutomationConfig): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - config.lockTimeoutMs);
  // A worker can crash after consuming the final attempt but before marking
  // the row. Retire those stale claims explicitly so they never remain stuck.
  await db.transaction(async (tx) => {
    const candidateIds = (
      await tx
        .select({ id: automationOutboxTable.id })
        .from(automationOutboxTable)
        .where(
          and(
            isNull(automationOutboxTable.processedAt),
            isNull(automationOutboxTable.discardedAt),
            isNotNull(automationOutboxTable.lockedAt),
            lt(automationOutboxTable.lockedAt, staleBefore),
            gte(automationOutboxTable.attempts, config.maxAttempts),
            inArray(automationOutboxTable.facilityId, [
              ...config.facilityAllowlist,
            ]),
          ),
        )
        .orderBy(asc(automationOutboxTable.createdAt))
        .limit(MAINTENANCE_BATCH_SIZE)
        .for("update", { skipLocked: true })
    ).map((row) => row.id);
    if (candidateIds.length === 0) return;
    const retired = await tx
      .update(automationOutboxTable)
      .set({
        lockedAt: null,
        discardedAt: now,
        lastErrorCode: "claim_expired_after_max_attempts",
      })
      .where(
        and(
          inArray(automationOutboxTable.id, candidateIds),
          isNull(automationOutboxTable.processedAt),
          isNull(automationOutboxTable.discardedAt),
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
    const candidateIds = (
      await tx
        .select({ id: automationOutboxTable.id })
        .from(automationOutboxTable)
        .where(
          and(
            isNull(automationOutboxTable.processedAt),
            isNull(automationOutboxTable.discardedAt),
            lt(automationOutboxTable.createdAt, pendingBefore),
            or(
              isNull(automationOutboxTable.lockedAt),
              lt(automationOutboxTable.lockedAt, staleLockBefore),
            ),
            inArray(automationOutboxTable.facilityId, [
              ...config.facilityAllowlist,
            ]),
          ),
        )
        .orderBy(asc(automationOutboxTable.createdAt))
        .limit(MAINTENANCE_BATCH_SIZE)
        .for("update", { skipLocked: true })
    ).map((row) => row.id);
    if (candidateIds.length === 0) return;
    const discarded = await tx
      .update(automationOutboxTable)
      .set({
        lockedAt: null,
        discardedAt: now,
        lastErrorCode: "stale_pending",
      })
      .where(
        and(
          inArray(automationOutboxTable.id, candidateIds),
          isNull(automationOutboxTable.processedAt),
          isNull(automationOutboxTable.discardedAt),
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
  if (!row.eventType.startsWith("credential.")) {
    return row.credentialId == null;
  }
  if (row.credentialId == null) return false;
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
      .where(
        and(
          eq(credentialsTable.id, row.credentialId),
          eq(usersTable.facilityId, row.facilityId),
        ),
      )
      .limit(1)
  )[0];
  if (!current || current.facilityId !== row.facilityId) {
    return false;
  }
  // Lifecycle notifications are immutable facts about a committed change.
  // A deleted credential must remain eligible for its deletion notification,
  // but its current owner still has to resolve to the event facility so an old
  // or forged outbox row can never cross the tenant boundary.
  if (row.eventType === "credential.lifecycle_changed") return true;
  if (current.deletedAt != null || !current.employeeActive) return false;
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
  await db.transaction(async (tx) => {
    const candidateIds = (
      await tx
        .select({ id: automationOutboxTable.id })
        .from(automationOutboxTable)
        .where(
          and(
            inArray(automationOutboxTable.facilityId, [
              ...config.facilityAllowlist,
            ]),
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
          ),
        )
        .orderBy(asc(automationOutboxTable.createdAt))
        .limit(MAINTENANCE_BATCH_SIZE)
        .for("update", { skipLocked: true })
    ).map((row) => row.id);
    if (candidateIds.length === 0) return;
    await tx
      .delete(automationOutboxTable)
      .where(inArray(automationOutboxTable.id, candidateIds));
  });
}

export async function runAutomationWorkerCycle(
  config: AutomationConfig,
): Promise<number> {
  if (!config.enabled) return 0;
  await enqueueExpiryDueEventsIfNeeded(config);
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
    if (
      !(await remainsDeliverable(row, row.payload as Record<string, unknown>))
    ) {
      await markFailed(row, config, "event_no_longer_deliverable", true);
      logger.warn(
        {
          eventId: row.id,
          eventType: row.eventType,
          facilityId: row.facilityId,
        },
        "Automation event discarded because its scoped state changed",
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
      const receiverContractFailure = receiverAlertErrorCodes.has(
        result.errorCode,
      );
      const receiverRetryLimit = Math.min(
        config.maxAttempts,
        RECEIVER_CONTRACT_RETRY_LIMIT,
      );
      const receiverRetryExhausted =
        receiverContractFailure && row.attempts >= receiverRetryLimit;
      await markFailed(
        row,
        config,
        result.errorCode,
        result.permanent || receiverRetryExhausted,
        result.retryAfterMs,
      );
      const logFields = {
        eventId: row.id,
        eventType: row.eventType,
        facilityId: row.facilityId,
        attempt: row.attempts,
        errorCode: result.errorCode,
      };
      if (receiverContractFailure) {
        logger.error(
          logFields,
          receiverRetryExhausted
            ? "Automation receiver contract failure exhausted bounded retries"
            : "Automation receiver contract failure; bounded retry scheduled",
        );
      } else {
        logger.warn(logFields, "Automation event delivery failed");
      }
    }
  }
  await cleanupOutbox(config);
  return claimedCount;
}

export async function runAutomationWorkerContinuously(
  config: AutomationConfig,
  signal: AbortSignal,
  options: ContinuousAutomationWorkerOptions = {},
): Promise<void> {
  const maxConsecutiveFailures =
    options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_CYCLE_FAILURES;
  if (
    !Number.isSafeInteger(maxConsecutiveFailures) ||
    maxConsecutiveFailures < 1 ||
    maxConsecutiveFailures > 20
  ) {
    throw new Error(
      "Automation worker max consecutive failures must be between 1 and 20",
    );
  }
  const runCycle = options.runCycle ?? runAutomationWorkerCycle;
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    try {
      await runCycle(config);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      logger.error(
        { ...safeErrorLogFields(error), consecutiveFailures },
        consecutiveFailures >= maxConsecutiveFailures
          ? "Automation worker unavailable after bounded consecutive cycle failures"
          : "Automation worker cycle failed; retry scheduled",
      );
      if (consecutiveFailures >= maxConsecutiveFailures) {
        // Never propagate the provider/database message or stack to the
        // embedded supervisor. It only needs a stable classification in order
        // to restart or fail the API process closed after its own retry budget.
        throw new AutomationWorkerUnavailableError();
      }
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, config.pollIntervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}
