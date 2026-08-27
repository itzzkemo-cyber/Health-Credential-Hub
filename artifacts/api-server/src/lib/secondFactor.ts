import { db, usersTable, type User } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  hashBackupCode,
  looksLikeBackupCode,
  verifyOtp,
} from "./totp";
import { decryptTotpSecret } from "./totpSecret";

type AuthTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Consume a second factor while the caller holds the user's row lock.
 * Backup codes are removed atomically and TOTP time steps are monotonic, so a
 * concurrent replay cannot authorize two administrative writes.
 */
export async function consumeSecondFactor(
  tx: AuthTransaction,
  user: User,
  code: string,
): Promise<User | null> {
  if (!user.totpSecret) return null;
  if (looksLikeBackupCode(code)) {
    const hash = hashBackupCode(code);
    const rows = await tx
      .update(usersTable)
      .set({ backupCodes: sql`${usersTable.backupCodes} - ${hash}` })
      .where(
        and(
          eq(usersTable.id, user.id),
          sql`${usersTable.backupCodes} ? ${hash}`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  const step = verifyOtp(decryptTotpSecret(user.totpSecret), code);
  if (step === null) return null;
  const rows = await tx
    .update(usersTable)
    .set({ totpLastUsedStep: step })
    .where(
      and(
        eq(usersTable.id, user.id),
        sql`(${usersTable.totpLastUsedStep} IS NULL OR ${usersTable.totpLastUsedStep} < ${step})`,
      ),
    )
    .returning();
  return rows[0] ?? null;
}
