import { db, employeeInvitationsTable } from "@workspace/db";
import { inArray, lt, or } from "drizzle-orm";
import { logger } from "./logger";

export const EMPLOYEE_INVITATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EMPLOYEE_INVITATION_CLEANUP_BATCH_SIZE = 200;
const EMPLOYEE_INVITATION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete one bounded batch of invitation PII once any terminal timestamp
 * (expiry, revocation, or acceptance) is at least 30 days old. Only row IDs
 * leave the select; no email or profile data is logged.
 */
export async function runEmployeeInvitationCleanup(
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - EMPLOYEE_INVITATION_RETENTION_MS);
  const candidates = await db
    .select({ id: employeeInvitationsTable.id })
    .from(employeeInvitationsTable)
    .where(
      or(
        lt(employeeInvitationsTable.expiresAt, cutoff),
        lt(employeeInvitationsTable.revokedAt, cutoff),
        lt(employeeInvitationsTable.acceptedAt, cutoff),
      ),
    )
    .orderBy(employeeInvitationsTable.id)
    .limit(EMPLOYEE_INVITATION_CLEANUP_BATCH_SIZE);
  if (candidates.length === 0) return 0;

  const deleted = await db
    .delete(employeeInvitationsTable)
    .where(
      inArray(
        employeeInvitationsTable.id,
        candidates.map((candidate) => candidate.id),
      ),
    )
    .returning({ id: employeeInvitationsTable.id });
  return deleted.length;
}

/** Create a non-overlapping tick function suitable for startup and intervals. */
export function createEmployeeInvitationCleanupRunner(
  cleanup: () => Promise<number> = () => runEmployeeInvitationCleanup(),
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await cleanup();
    } catch {
      // Intentionally exclude the database error object: provider/driver
      // messages can contain statement parameters. Operators get a stable
      // failure signal without invitation PII.
      logger.error("Employee invitation retention cleanup failed");
    } finally {
      running = false;
    }
  };
}

/**
 * Retention is unconditional: every API process starts it. Multiple instances
 * may race harmlessly on the same IDs, while each instance prevents local
 * overlap and deletes no more than one bounded batch per hourly tick.
 */
export function startEmployeeInvitationCleanup(): () => void {
  const tick = createEmployeeInvitationCleanupRunner();
  void tick();
  const timer = setInterval(
    () => void tick(),
    EMPLOYEE_INVITATION_CLEANUP_INTERVAL_MS,
  );
  timer.unref();
  return () => clearInterval(timer);
}
