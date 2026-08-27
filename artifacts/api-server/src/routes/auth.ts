import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import {
  db,
  auditLogsTable,
  usersTable,
  passwordResetTokensTable,
  employeeInvitationsTable,
  departmentsTable,
  facilitiesTable,
  type User,
} from "@workspace/db";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  signToken,
  signPurposeToken,
  createTwoFactorChallengeToken,
  verifyPurposeToken,
  comparePassword,
  hashPassword,
  requireAuth,
  requireRole,
  getUser,
  setSessionCookie,
  clearSessionCookie,
  ADMIN_ROLES,
} from "../lib/auth";
import {
  generateTotpSecret,
  buildOtpauthUrl,
  verifyOtp,
  generateBackupCodes,
} from "../lib/totp";
import QRCode from "qrcode";
import {
  serializeUser,
  logAudit,
  syncExpiryNotifications,
} from "../lib/helpers";
import { canManageTarget } from "../lib/roleHierarchy";
import { sessionIssuanceCsrfGuard } from "../lib/csrf";
import { encryptTotpSecret } from "../lib/totpSecret";
import { consumeSecondFactor } from "../lib/secondFactor";
import { isFreshActiveSessionActor } from "../lib/sessionFreshness";
import { logger } from "../lib/logger";
import { safeErrorLogFields } from "../lib/safeError";
import { rateLimit } from "../lib/rateLimit";
import {
  EmailNotConfiguredError,
  createEmailIdempotencyKey,
  isEmailConfigured,
  isFixtureRecipient,
  sendEmail,
} from "../lib/email/sender";
import {
  getPasswordResetUrl,
  passwordResetEmail,
} from "../lib/email/templates";

const router: IRouter = Router();
const loginRateLimit = rateLimit({
  name: "login",
  max: 10,
  windowMs: 10 * 60_000,
});
const recoveryRateLimit = rateLimit({
  name: "recovery",
  max: 5,
  windowMs: 60 * 60_000,
});
const invitationAcceptanceRateLimit = rateLimit({
  name: "accept-invitation",
  max: 10,
  windowMs: 15 * 60_000,
});
const changePasswordRateLimit = rateLimit({
  name: "change-password",
  max: 5,
  windowMs: 15 * 60_000,
});
const totpSensitiveRateLimit = rateLimit({
  name: "totp-sensitive",
  max: 10,
  windowMs: 10 * 60_000,
});

// A real bcrypt hash keeps nonexistent-account login attempts on the same
// expensive verification path as known accounts. The plaintext used to create
// this fixed hash is deliberately not accepted by any account.
const INVALID_LOGIN_PASSWORD_HASH =
  "$2b$10$mIJvHTDiPlLOecA3/wPLPOJRh2/PLKiiTnqSCIiSvC7EJyeg84qJ.";

function isPostgresUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}

function auditEntry(
  user: User,
  action: string,
  actionAr: string,
  target: string,
  targetAr: string,
  ipAddress?: string,
  facilityId: number = user.facilityId,
) {
  return {
    userId: user.id,
    facilityId,
    userName: user.name,
    userNameAr: user.nameAr,
    action,
    actionAr,
    target,
    targetAr,
    details: null,
    ipAddress: ipAddress ?? null,
  };
}

/**
 * Complete a successful authentication: sync notifications, audit, then issue
 * the session. The token is set only as an httpOnly cookie so web JavaScript
 * can never read or exfiltrate the reusable session credential. Every route
 * that calls this MUST be registered with `sessionIssuanceCsrfGuard` (login
 * CSRF).
 */
async function issueSession(
  user: User,
  req: Request,
  res: Response,
  actionEn = "Signed in",
  actionAr = "تسجيل دخول",
): Promise<void> {
  await syncExpiryNotifications(user);
  await logAudit(
    user,
    actionEn,
    actionAr,
    "Session",
    "الجلسة",
    undefined,
    req.ip,
  );
  const token = signToken(user.id, user.sessionVersion);
  setSessionCookie(res, token);
  res.json({ user: serializeUser(user) });
}

router.post(
  "/auth/login",
  loginRateLimit,
  sessionIssuanceCsrfGuard,
  async (req, res) => {
    const { email, password } = req.body as {
      email?: string;
      password?: string;
    };
    if (!email || !password) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    const normalizedEmail = email.toLowerCase().trim();
    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, normalizedEmail));
    const user = rows[0];
    const ok = await comparePassword(
      password,
      user?.passwordHash ?? INVALID_LOGIN_PASSWORD_HASH,
    );
    if (!user || !user.isActive || !ok) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    if (user.totpEnabled && !user.totpSecret) {
      logger.error(
        { userId: user.id },
        "Blocked login because the 2FA account state is inconsistent",
      );
      res.status(503).json({
        message:
          "Account security configuration requires administrator attention",
        messageAr: "إعدادات أمان الحساب تحتاج إلى مراجعة المسؤول",
      });
      return;
    }
    if (user.totpEnabled) {
      respondWithTwoFactorChallenge(user, res);
      return;
    }
    await issueSession(user, req, res);
  },
);

// Correct password, but the account has 2FA enabled: 202 with a challenge
// token instead of a session (see createTwoFactorChallengeToken).
function respondWithTwoFactorChallenge(user: User, res: Response): void {
  res.status(202).json({
    pending2fa: true,
    challengeToken: createTwoFactorChallengeToken(user),
  });
}

router.post("/auth/logout", requireAuth, async (req, res) => {
  const user = getUser(req);
  const result = await db.transaction(async (tx) => {
    const locked = (
      await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, user.id))
        .for("update")
    )[0];
    if (!isFreshActiveSessionActor(locked, user)) {
      return { kind: "unauthorized" as const };
    }
    const row = (
      await tx
        .update(usersTable)
        .set({ sessionVersion: sql`${usersTable.sessionVersion} + 1` })
        .where(
          and(
            eq(usersTable.id, locked.id),
            eq(usersTable.sessionVersion, locked.sessionVersion),
          ),
        )
        .returning()
    )[0];
    if (!row) return { kind: "unauthorized" as const };
    await tx
      .insert(auditLogsTable)
      .values(
        auditEntry(
          row,
          "Signed out",
          "تسجيل خروج",
          "Session",
          "الجلسة",
          req.ip,
        ),
      );
    return { kind: "signed_out" as const };
  });
  if (result.kind === "unauthorized") {
    clearSessionCookie(res);
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  // Logout is global for this account: revoke every bearer token/cookie, then
  // clear the current browser cookie as well.
  clearSessionCookie(res);
  res.json({});
});

router.get("/auth/me", requireAuth, (req, res) => {
  res.json(serializeUser(getUser(req)));
});

router.post(
  "/auth/change-password",
  requireAuth,
  changePasswordRateLimit,
  async (req, res) => {
    const user = getUser(req);
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword || newPassword.length < 12) {
      res
        .status(400)
        .json({ message: "Password must be at least 12 characters" });
      return;
    }
    const nextPasswordHash = await hashPassword(newPassword);
    const result = await db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .for("update")
      )[0];
      if (!isFreshActiveSessionActor(locked, user)) {
        return { kind: "unauthorized" as const };
      }
      if (!(await comparePassword(currentPassword, locked.passwordHash))) {
        return { kind: "wrong_password" as const };
      }
      if (await comparePassword(newPassword, locked.passwordHash)) {
        return { kind: "password_reused" as const };
      }
      const updated = (
        await tx
          .update(usersTable)
          .set({
            passwordHash: nextPasswordHash,
            mustChangePassword: false,
            // "Log out everywhere": revoke all sessions issued before this change…
            sessionVersion: sql`${usersTable.sessionVersion} + 1`,
          })
          .where(eq(usersTable.id, locked.id))
          .returning()
      )[0];
      if (!updated) return { kind: "wrong_password" as const };
      await tx
        .insert(auditLogsTable)
        .values(
          auditEntry(
            updated,
            "Changed password",
            "تغيير كلمة المرور",
            "Account",
            "الحساب",
            req.ip,
          ),
        );
      return { kind: "updated" as const, user: updated };
    });
    if (result.kind === "wrong_password") {
      res.status(400).json({ message: "Current password is incorrect" });
      return;
    }
    if (result.kind === "unauthorized") {
      clearSessionCookie(res);
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "password_reused") {
      res.status(400).json({
        code: "PASSWORD_REUSE_NOT_ALLOWED",
        message: "The new password must be different from the current password",
        messageAr:
          "يجب أن تكون كلمة المرور الجديدة مختلفة عن كلمة المرور الحالية",
      });
      return;
    }
    const updated = result.user;
    // …but keep THIS browser alive with a new httpOnly cookie at the new
    // session version. The reusable JWT is deliberately absent from the body.
    const freshToken = signToken(updated.id, updated.sessionVersion);
    setSessionCookie(res, freshToken);
    res.json({ success: true });
  },
);

// --- Two-factor authentication (TOTP) ---------------------------------------

const MAX_CHALLENGE_ATTEMPTS = 5;
const CHALLENGE_STATE_TTL_MS = 6 * 60 * 1000; // outlives the 5m token
// Per-challenge attempt counters + used-token registry, keyed by jti.
// In-memory is fine for a single instance: state loss on restart only means
// a fresh 5-attempt budget for tokens that still expire within minutes.
const challengeAttempts = new Map<
  string,
  { count: number; expiresAt: number }
>();
const usedChallenges = new Map<string, number>();

function pruneChallengeState(): void {
  const now = Date.now();
  for (const [jti, entry] of challengeAttempts) {
    if (entry.expiresAt < now) challengeAttempts.delete(jti);
  }
  for (const [jti, expiresAt] of usedChallenges) {
    if (expiresAt < now) usedChallenges.delete(jti);
  }
}

// Step 1 of enabling: generate a secret and hand it back WITHOUT persisting.
// The signed setup token carries the secret so verify-setup can trust it
// unmodified; nothing touches the DB until the user proves their app works.
router.post(
  "/auth/totp/setup",
  requireAuth,
  totpSensitiveRateLimit,
  async (req, res) => {
    const user = getUser(req);
    const body = req.body as { currentPassword?: unknown };
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const verifiedActor = await db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .for("update")
      )[0];
      if (!isFreshActiveSessionActor(locked, user)) {
        return { kind: "unauthorized" as const };
      }
      if (locked.totpEnabled) return { kind: "already_enabled" as const };
      if (
        !currentPassword ||
        !(await comparePassword(currentPassword, locked.passwordHash))
      ) {
        return { kind: "step_up_failed" as const };
      }
      return { kind: "verified" as const, actor: locked };
    });
    if (verifiedActor.kind === "unauthorized") {
      clearSessionCookie(res);
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (verifiedActor.kind === "already_enabled") {
      res.status(400).json({
        message: "Two-factor authentication is already enabled",
        messageAr: "المصادقة الثنائية مفعّلة مسبقاً",
      });
      return;
    }
    if (verifiedActor.kind === "step_up_failed") {
      res.status(403).json({
        code: "step_up_failed",
        message: "Current-password verification failed",
        messageAr: "فشل التحقق من كلمة المرور الحالية",
      });
      return;
    }

    const actor = verifiedActor.actor;
    const secret = generateTotpSecret();
    const otpauthUrl = buildOtpauthUrl(secret, actor.email);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      margin: 1,
      width: 240,
    });
    const setupToken = signPurposeToken(
      "totp_setup",
      actor.id,
      { s: secret, v: actor.sessionVersion },
      "10m",
    );
    res.json({ secret, otpauthUrl, qrDataUrl, setupToken });
  },
);

// Step 2 of enabling: first valid OTP activates 2FA and issues backup codes.
router.post(
  "/auth/totp/verify-setup",
  requireAuth,
  totpSensitiveRateLimit,
  async (req, res) => {
    const user = getUser(req);
    const body = req.body as { setupToken?: unknown; code?: unknown };
    const setupToken =
      typeof body.setupToken === "string" ? body.setupToken : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (user.totpEnabled) {
      res.status(400).json({
        message: "Two-factor authentication is already enabled",
        messageAr: "المصادقة الثنائية مفعّلة مسبقاً",
      });
      return;
    }
    const payload = setupToken
      ? verifyPurposeToken(setupToken, "totp_setup")
      : null;
    const secret = payload && typeof payload.s === "string" ? payload.s : null;
    if (!payload || !secret || Number(payload.sub) !== user.id) {
      res.status(400).json({
        code: "setup_expired",
        message: "The setup session has expired — start again",
        messageAr: "انتهت صلاحية جلسة الإعداد — ابدأ من جديد",
      });
      return;
    }
    const step = verifyOtp(secret, code);
    if (step === null) {
      res.status(400).json({
        code: "invalid_code",
        message: "The verification code is incorrect",
        messageAr: "رمز التحقق غير صحيح",
      });
      return;
    }
    const codes = generateBackupCodes();
    const enabledResult = await db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .for("update")
      )[0];
      if (!isFreshActiveSessionActor(locked, user)) {
        return { kind: "unauthorized" as const };
      }
      if (
        locked.totpEnabled ||
        (typeof payload.v === "number" ? payload.v : -1) !==
          locked.sessionVersion
      ) {
        return { kind: "state_changed" as const };
      }
      const updated = (
        await tx
          .update(usersTable)
          .set({
            totpSecret: encryptTotpSecret(secret),
            totpEnabled: true,
            backupCodes: codes.hashes,
            totpLastUsedStep: step,
            // Existing sessions authenticated without the newly enabled factor.
            // Revoke them and refresh only this step-up-confirmed browser below.
            sessionVersion: sql`${usersTable.sessionVersion} + 1`,
          })
          .where(eq(usersTable.id, locked.id))
          .returning()
      )[0];
      if (!updated) return { kind: "state_changed" as const };
      await tx
        .insert(auditLogsTable)
        .values(
          auditEntry(
            updated,
            "Enabled two-factor authentication",
            "تفعيل المصادقة الثنائية",
            "Account",
            "الحساب",
            req.ip,
          ),
        );
      return { kind: "enabled" as const, user: updated };
    });
    if (enabledResult.kind === "unauthorized") {
      clearSessionCookie(res);
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (enabledResult.kind === "state_changed") {
      res.status(409).json({
        message: "Two-factor authentication state changed — start again",
        messageAr: "تغيرت حالة المصادقة الثنائية — ابدأ من جديد",
      });
      return;
    }
    const enabled = enabledResult.user;
    setSessionCookie(res, signToken(enabled.id, enabled.sessionVersion));
    res.json({ backupCodes: codes.plaintext });
  },
);

// Step 2 of login for 2FA accounts: challenge token + OTP/backup code → session.
router.post(
  "/auth/totp/challenge",
  loginRateLimit,
  sessionIssuanceCsrfGuard,
  async (req, res) => {
    pruneChallengeState();
    const body = req.body as { challengeToken?: unknown; code?: unknown };
    const challengeToken =
      typeof body.challengeToken === "string" ? body.challengeToken : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const expired = () =>
      res.status(401).json({
        code: "expired_challenge",
        message: "The sign-in challenge has expired — log in again",
        messageAr: "انتهت صلاحية جلسة التحقق — سجّل الدخول من جديد",
      });

    const payload = challengeToken
      ? verifyPurposeToken(challengeToken, "2fa_challenge")
      : null;
    const jti = payload && typeof payload.jti === "string" ? payload.jti : null;
    if (!payload || !jti) {
      expired();
      return;
    }
    if (usedChallenges.has(jti)) {
      expired();
      return;
    }
    // Claim-first, all synchronous (no awaits yet): the attempt is counted and
    // the jti marked in-flight BEFORE any async verification, so parallel
    // requests can neither undercount the cap nor double-spend one challenge
    // (same claim-first idea the email ledger uses at the DB level).
    const attempts = challengeAttempts.get(jti) ?? {
      count: 0,
      expiresAt: Date.now() + CHALLENGE_STATE_TTL_MS,
    };
    challengeAttempts.set(jti, attempts);
    attempts.count += 1;
    if (attempts.count > MAX_CHALLENGE_ATTEMPTS) {
      res.status(401).json({
        code: "too_many_attempts",
        message: "Too many incorrect codes — log in again",
        messageAr: "محاولات خاطئة كثيرة — سجّل الدخول من جديد",
      });
      return;
    }
    usedChallenges.set(jti, Date.now() + CHALLENGE_STATE_TTL_MS);

    let succeeded = false;
    try {
      const userId = Number(payload.sub);
      const consumed =
        Number.isFinite(userId) && code
          ? await db.transaction(async (tx) => {
              const locked = (
                await tx
                  .select()
                  .from(usersTable)
                  .where(eq(usersTable.id, userId))
                  .for("update")
              )[0];
              // The version pin voids challenges issued before a password
              // reset/change. Recheck it while holding the account lock.
              if (
                !locked ||
                !locked.isActive ||
                !locked.totpEnabled ||
                !locked.totpSecret ||
                (typeof payload.v === "number" ? payload.v : -1) !==
                  locked.sessionVersion
              ) {
                return { kind: "expired" as const };
              }
              const fresh = await consumeSecondFactor(tx, locked, code);
              return fresh
                ? { kind: "accepted" as const, user: fresh }
                : { kind: "invalid" as const };
            })
          : { kind: "expired" as const };
      if (consumed.kind === "expired") {
        expired();
        return;
      }
      if (consumed.kind === "invalid") {
        res.status(401).json({
          code: "invalid_code",
          message: "The verification code is incorrect",
          messageAr: "رمز التحقق غير صحيح",
        });
        return;
      }
      challengeAttempts.delete(jti);
      succeeded = true;
      await issueSession(
        consumed.user,
        req,
        res,
        "Signed in (2FA)",
        "تسجيل دخول (تحقق ثنائي)",
      );
    } finally {
      // Any non-success exit releases the in-flight claim so the user can retry
      // with the same challenge; the attempt above stays counted either way.
      if (!succeeded) usedChallenges.delete(jti);
    }
  },
);

// Disabling requires password AND a second factor — a stolen password alone
// must never be enough to switch the protection off.
router.delete(
  "/auth/totp/disable",
  requireAuth,
  totpSensitiveRateLimit,
  async (req, res) => {
    const user = getUser(req);
    const body = req.body as { currentPassword?: unknown; code?: unknown };
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const result = await db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .for("update")
      )[0];
      if (!isFreshActiveSessionActor(locked, user)) {
        return { kind: "unauthorized" as const };
      }
      if (!locked.totpEnabled || !locked.totpSecret) {
        return { kind: "not_enabled" as const };
      }
      if (
        !currentPassword ||
        !(await comparePassword(currentPassword, locked.passwordHash))
      ) {
        return { kind: "wrong_password" as const };
      }
      const fresh = code ? await consumeSecondFactor(tx, locked, code) : null;
      if (!fresh) return { kind: "invalid_code" as const };
      const updated = (
        await tx
          .update(usersTable)
          .set({
            totpSecret: null,
            totpEnabled: false,
            backupCodes: null,
            totpLastUsedStep: null,
            sessionVersion: sql`${usersTable.sessionVersion} + 1`,
          })
          .where(eq(usersTable.id, locked.id))
          .returning()
      )[0];
      if (!updated) return { kind: "not_enabled" as const };
      await tx
        .insert(auditLogsTable)
        .values(
          auditEntry(
            updated,
            "Disabled two-factor authentication",
            "إلغاء تفعيل المصادقة الثنائية",
            "Account",
            "الحساب",
            req.ip,
          ),
        );
      return { kind: "disabled" as const, user: updated };
    });
    if (result.kind === "not_enabled") {
      res.status(400).json({
        message: "Two-factor authentication is not enabled",
        messageAr: "المصادقة الثنائية غير مفعّلة",
      });
      return;
    }
    if (result.kind === "unauthorized") {
      clearSessionCookie(res);
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "wrong_password") {
      res.status(400).json({
        code: "wrong_password",
        message: "Current password is incorrect",
        messageAr: "كلمة المرور الحالية غير صحيحة",
      });
      return;
    }
    if (result.kind === "invalid_code") {
      res.status(400).json({
        code: "invalid_code",
        message: "The verification code is incorrect",
        messageAr: "رمز التحقق غير صحيح",
      });
      return;
    }
    setSessionCookie(
      res,
      signToken(result.user.id, result.user.sessionVersion),
    );
    res.json({});
  },
);

// Fresh batch of backup codes (invalidates all previous ones). Requires
// password + second factor, same bar as disabling.
router.post(
  "/auth/totp/regenerate-backup",
  requireAuth,
  totpSensitiveRateLimit,
  async (req, res) => {
    const user = getUser(req);
    const body = req.body as { currentPassword?: unknown; code?: unknown };
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const codes = generateBackupCodes();
    const result = await db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
          .for("update")
      )[0];
      if (!isFreshActiveSessionActor(locked, user)) {
        return "unauthorized" as const;
      }
      if (!locked.totpEnabled || !locked.totpSecret) {
        return "not_enabled" as const;
      }
      if (
        !currentPassword ||
        !(await comparePassword(currentPassword, locked.passwordHash))
      ) {
        return "wrong_password" as const;
      }
      const fresh = code ? await consumeSecondFactor(tx, locked, code) : null;
      if (!fresh) return "invalid_code" as const;
      const updated = (
        await tx
          .update(usersTable)
          .set({ backupCodes: codes.hashes })
          .where(eq(usersTable.id, locked.id))
          .returning()
      )[0];
      if (!updated) return "not_enabled" as const;
      await tx
        .insert(auditLogsTable)
        .values(
          auditEntry(
            updated,
            "Regenerated 2FA backup codes",
            "إعادة توليد الرموز الاحتياطية للمصادقة الثنائية",
            "Account",
            "الحساب",
            req.ip,
          ),
        );
      return "regenerated" as const;
    });
    if (result === "not_enabled") {
      res.status(400).json({
        message: "Two-factor authentication is not enabled",
        messageAr: "المصادقة الثنائية غير مفعّلة",
      });
      return;
    }
    if (result === "unauthorized") {
      clearSessionCookie(res);
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result === "wrong_password") {
      res.status(400).json({
        code: "wrong_password",
        message: "Current password is incorrect",
        messageAr: "كلمة المرور الحالية غير صحيحة",
      });
      return;
    }
    if (result === "invalid_code") {
      res.status(400).json({
        code: "invalid_code",
        message: "The verification code is incorrect",
        messageAr: "رمز التحقق غير صحيح",
      });
      return;
    }
    res.json({ backupCodes: codes.plaintext });
  },
);

// Admin recovery path: a fully stepped-up administrator can switch 2FA off for
// a lower-ranked, in-scope account. A long-lived/stolen session is insufficient:
// the actor must re-prove their password and their own second factor.
router.post(
  "/auth/totp/admin-disable",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  totpSensitiveRateLimit,
  async (req, res) => {
    const admin = getUser(req);
    const body = req.body as {
      userId?: unknown;
      currentPassword?: unknown;
      code?: unknown;
    };
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const targetId =
      typeof body.userId === "number" &&
      Number.isInteger(body.userId) &&
      body.userId > 0
        ? body.userId
        : NaN;
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ message: "userId is required" });
      return;
    }
    // The recovery path must never become a self-service bypass of the
    // password+second-factor requirement in /auth/totp/disable.
    if (targetId === admin.id) {
      res.status(403).json({
        message:
          "Use the regular disable flow (password + code) for your own account",
        messageAr:
          "لإلغاء التفعيل لحسابك استخدم المسار الاعتيادي (كلمة المرور + رمز التحقق)",
      });
      return;
    }
    const result = await db.transaction(async (tx) => {
      // Stable lock order prevents role/facility changes from racing the final
      // recovery decision and avoids actor/target deadlocks.
      const lockedUsers = await tx
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, [admin.id, targetId]))
        .orderBy(usersTable.id)
        .for("update");
      const actor = lockedUsers.find((entry) => entry.id === admin.id);
      const target = lockedUsers.find((entry) => entry.id === targetId);
      if (!isFreshActiveSessionActor(actor, admin)) {
        return { kind: "unauthorized" as const };
      }
      if (
        !ADMIN_ROLES.includes(actor.role) ||
        !target ||
        !canManageTarget(actor, target)
      ) {
        return { kind: "not_found" as const };
      }
      if (!target.totpEnabled) return { kind: "not_enabled" as const };
      if (!actor.totpEnabled || !actor.totpSecret) {
        return { kind: "admin_mfa_required" as const };
      }
      if (
        !currentPassword ||
        !(await comparePassword(currentPassword, actor.passwordHash))
      ) {
        return { kind: "step_up_failed" as const };
      }
      const steppedUp = code
        ? await consumeSecondFactor(tx, actor, code)
        : null;
      if (!steppedUp) return { kind: "step_up_failed" as const };

      const updated = (
        await tx
          .update(usersTable)
          .set({
            totpSecret: null,
            totpEnabled: false,
            backupCodes: null,
            totpLastUsedStep: null,
            // Administrative recovery is a high-impact account change. Revoke
            // every target session and any outstanding 2FA challenge token.
            sessionVersion: sql`${usersTable.sessionVersion} + 1`,
          })
          .where(eq(usersTable.id, target.id))
          .returning()
      )[0];
      if (!updated) return { kind: "not_found" as const };
      await tx
        .insert(auditLogsTable)
        .values(
          auditEntry(
            actor,
            `Disabled two-factor authentication for ${target.name}`,
            `إلغاء تفعيل المصادقة الثنائية للموظف ${target.nameAr}`,
            "Account",
            "الحساب",
            req.ip,
            target.facilityId,
          ),
        );
      return { kind: "disabled" as const };
    });
    // Do not reveal whether an out-of-scope or equal/higher-ranked account
    // exists. System admins remain the only global recovery authority.
    if (result.kind === "not_found") {
      res.status(404).json({
        message: "Employee not found",
        messageAr: "الموظف غير موجود",
      });
      return;
    }
    if (result.kind === "unauthorized") {
      clearSessionCookie(res);
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "not_enabled") {
      res.status(400).json({
        message: "Two-factor authentication is not enabled for this account",
        messageAr: "المصادقة الثنائية غير مفعّلة لهذا الحساب",
      });
      return;
    }
    if (result.kind === "admin_mfa_required") {
      res.status(403).json({
        code: "admin_mfa_required",
        message: "Enable two-factor authentication on your admin account first",
        messageAr: "فعّل المصادقة الثنائية لحساب المسؤول أولاً",
      });
      return;
    }
    if (result.kind === "step_up_failed") {
      res.status(403).json({
        code: "step_up_failed",
        message: "Administrator step-up verification failed",
        messageAr: "فشل التحقق الإضافي من هوية المسؤول",
      });
      return;
    }
    res.json({});
  },
);

const INVALID_INVITATION_RESPONSE = {
  code: "invalid_invitation",
  message: "This employee invitation is invalid, expired, or already used",
  messageAr: "دعوة الموظف غير صالحة أو منتهية أو مستخدمة مسبقًا",
} as const;

router.post(
  "/auth/accept-invitation",
  invitationAcceptanceRateLimit,
  sessionIssuanceCsrfGuard,
  async (req, res) => {
    const body =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    if (
      Object.keys(body).some(
        (field) => field !== "token" && field !== "password",
      )
    ) {
      res.status(400).json(INVALID_INVITATION_RESPONSE);
      return;
    }
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || password.length < 12 || password.length > 1024) {
      res.status(400).json({
        code: "weak_password",
        message: "Password must be between 12 and 1024 characters",
        messageAr: "يجب أن تكون كلمة المرور بين 12 و1024 حرفًا",
      });
      return;
    }
    // Tokens are fixed-width lowercase hex. Do not trim: any mutation of the
    // bearer value must fail rather than silently accepting a modified token.
    if (!/^[0-9a-f]{64}$/.test(token)) {
      res.status(400).json(INVALID_INVITATION_RESPONSE);
      return;
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const passwordHash = await hashPassword(password);
    let result;
    try {
      result = await db.transaction(async (tx) => {
        // Read only the stored invitation metadata needed to acquire locks in
        // the same department -> users -> invitation order as administrative
        // writes. The final authorization decision uses the locked row below.
        const candidate = (
          await tx
            .select()
            .from(employeeInvitationsTable)
            .where(eq(employeeInvitationsTable.tokenHash, tokenHash))
        )[0];
        if (!candidate) return { kind: "invalid" as const };

        const department =
          candidate.departmentId == null
            ? null
            : (
                await tx
                  .select({
                    id: departmentsTable.id,
                    facilityId: departmentsTable.facilityId,
                  })
                  .from(departmentsTable)
                  .where(
                    and(
                      eq(departmentsTable.id, candidate.departmentId),
                      isNull(departmentsTable.deletedAt),
                    ),
                  )
                  .for("key share")
              )[0];

        const relatedUserIds = [
          candidate.invitedBy,
          ...(candidate.supervisorId == null ? [] : [candidate.supervisorId]),
        ]
          .filter((value, index, values) => values.indexOf(value) === index)
          .sort((left, right) => left - right);
        const relatedUsers = await tx
          .select()
          .from(usersTable)
          .where(inArray(usersTable.id, relatedUserIds))
          .orderBy(usersTable.id)
          .for("update");

        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${candidate.email}, 0))`,
        );
        const invitation = (
          await tx
            .select()
            .from(employeeInvitationsTable)
            .where(eq(employeeInvitationsTable.id, candidate.id))
            .for("update")
        )[0];
        if (!invitation || invitation.tokenHash !== tokenHash) {
          return { kind: "invalid" as const };
        }

        const now = new Date();
        const invalidate = async () => {
          if (!invitation.acceptedAt && !invitation.revokedAt) {
            await tx
              .update(employeeInvitationsTable)
              .set({ revokedAt: now })
              .where(
                and(
                  eq(employeeInvitationsTable.id, invitation.id),
                  isNull(employeeInvitationsTable.acceptedAt),
                  isNull(employeeInvitationsTable.revokedAt),
                ),
              );
          }
          return { kind: "invalid" as const };
        };
        if (
          invitation.acceptedAt ||
          invitation.revokedAt ||
          invitation.expiresAt.getTime() <= now.getTime()
        ) {
          return invalidate();
        }

        const inviter = relatedUsers.find(
          (candidateUser) => candidateUser.id === invitation.invitedBy,
        );
        if (
          !inviter ||
          !inviter.isActive ||
          (inviter.role !== "hospital_admin" &&
            inviter.role !== "system_admin") ||
          (inviter.role === "hospital_admin" &&
            inviter.facilityId !== invitation.facilityId)
        ) {
          return invalidate();
        }
        const facility = await tx
          .select({ id: facilitiesTable.id })
          .from(facilitiesTable)
          .where(eq(facilitiesTable.id, invitation.facilityId));
        if (facility.length === 0) return invalidate();
        if (
          invitation.departmentId != null &&
          (!department || department.facilityId !== invitation.facilityId)
        ) {
          return invalidate();
        }
        if (invitation.supervisorId != null) {
          const supervisor = relatedUsers.find(
            (candidateUser) => candidateUser.id === invitation.supervisorId,
          );
          if (
            !supervisor ||
            !supervisor.isActive ||
            supervisor.role === "employee" ||
            supervisor.facilityId !== invitation.facilityId
          ) {
            return invalidate();
          }
        }

        const existing = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.email, invitation.email));
        if (existing.length > 0) return invalidate();

        const acceptedUser = (
          await tx
            .insert(usersTable)
            .values({
              email: invitation.email,
              passwordHash,
              name: invitation.name,
              nameAr: invitation.nameAr,
              role: "employee",
              departmentId: invitation.departmentId,
              supervisorId: invitation.supervisorId,
              facilityId: invitation.facilityId,
              jobTitle: invitation.jobTitle,
              jobTitleAr: invitation.jobTitleAr,
              employeeNumber: invitation.employeeNumber,
              phone: invitation.phone,
              isActive: true,
              mustChangePassword: false,
              // No session is issued here. Starting at version 1 also makes
              // any impossible pre-provisioning/version-0 token unusable.
              sessionVersion: 1,
            })
            .returning()
        )[0];
        if (!acceptedUser)
          throw new Error("Invitation acceptance returned no user");

        const acceptedInvitation = (
          await tx
            .update(employeeInvitationsTable)
            .set({ acceptedAt: now, acceptedUserId: acceptedUser.id })
            .where(
              and(
                eq(employeeInvitationsTable.id, invitation.id),
                isNull(employeeInvitationsTable.acceptedAt),
                isNull(employeeInvitationsTable.revokedAt),
                gt(employeeInvitationsTable.expiresAt, now),
              ),
            )
            .returning({ id: employeeInvitationsTable.id })
        )[0];
        if (!acceptedInvitation) {
          throw new Error("Invitation terminal-state update lost its lock");
        }
        await tx.insert(auditLogsTable).values({
          userId: acceptedUser.id,
          facilityId: acceptedUser.facilityId,
          userName: acceptedUser.name,
          userNameAr: acceptedUser.nameAr,
          action: "Accepted employee invitation",
          actionAr: "قبول دعوة الموظف",
          target: "Account",
          targetAr: "الحساب",
          details: null,
          ipAddress: req.ip ?? null,
        });
        return { kind: "accepted" as const };
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        // A legacy/direct provisioning route may race the invitation despite
        // the per-email advisory lock. Revoke the link and keep the public
        // response indistinguishable from every other invalid invitation.
        await db
          .update(employeeInvitationsTable)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(employeeInvitationsTable.tokenHash, tokenHash),
              isNull(employeeInvitationsTable.acceptedAt),
              isNull(employeeInvitationsTable.revokedAt),
            ),
          );
        res.status(400).json(INVALID_INVITATION_RESPONSE);
        return;
      }
      throw error;
    }

    if (result.kind !== "accepted") {
      res.status(400).json(INVALID_INVITATION_RESPONSE);
      return;
    }
    // Deliberately no session cookie or user object. The employee signs in
    // normally after activation, keeping account creation separate from auth.
    res.status(201).json({
      success: true,
      message: "Employee account activated; you can now sign in",
      messageAr: "تم تفعيل حساب الموظف ويمكنك تسجيل الدخول الآن",
    });
  },
);

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // reset links are valid for 1 hour

router.post("/auth/forgot-password", recoveryRateLimit, async (req, res) => {
  const body = req.body as { email?: unknown };
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  // Uniform 200 regardless of outcome (no account enumeration) — and respond
  // *before* the lookup/email work so response timing is uniform too.
  res.json({});
  if (!email) return;
  try {
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const user = await db.transaction(async (tx) => {
      const locked = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.email, email))
          .for("update")
      )[0];
      if (!locked || !locked.isActive) return null;
      // Single-active-link policy: requesting a new link voids older unused
      // ones in the same transaction that creates and audits the replacement.
      await tx
        .update(passwordResetTokensTable)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokensTable.userId, locked.id),
            isNull(passwordResetTokensTable.usedAt),
          ),
        );
      await tx.insert(passwordResetTokensTable).values({
        userId: locked.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      });
      await tx
        .insert(auditLogsTable)
        .values(
          auditEntry(
            locked,
            "Requested password reset",
            "طلب إعادة تعيين كلمة المرور",
            "Account",
            "الحساب",
            req.ip,
          ),
        );
      return locked;
    });
    if (!user) return;

    const resetUrl = getPasswordResetUrl(rawToken);
    if (!resetUrl || !isEmailConfigured() || isFixtureRecipient(user.email)) {
      logger.warn(
        { userId: user.id },
        "Password reset link created but not emailed (provider unavailable or fixture recipient)",
      );
      return;
    }
    await sendEmail({
      to: user.email,
      subject: "إعادة تعيين كلمة المرور | Reset your HealthDocs password",
      html: passwordResetEmail({
        nameAr: user.nameAr,
        name: user.name,
        resetUrl,
      }),
      idempotencyKey: createEmailIdempotencyKey("password-reset", tokenHash),
    });
    logger.info({ userId: user.id }, "Password reset email sent");
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      logger.warn("Password reset email skipped — provider not configured");
      return;
    }
    // Response already sent; log for operators, never leak to the caller.
    logger.error(safeErrorLogFields(err), "Password reset processing failed");
  }
});

router.post(
  "/auth/reset-password",
  recoveryRateLimit,
  sessionIssuanceCsrfGuard,
  async (req, res) => {
    const body = req.body as { token?: unknown; newPassword?: unknown };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : "";
    if (!token || !newPassword || newPassword.length < 12) {
      res.status(400).json({
        code: "weak_password",
        message:
          "A reset token and a password of at least 12 characters are required",
        messageAr: "رمز إعادة التعيين وكلمة مرور لا تقل عن 12 حرفًا مطلوبان",
      });
      return;
    }
    const invalid = () =>
      res.status(400).json({
        code: "invalid_token",
        message: "This reset link is invalid or has expired",
        messageAr: "رابط إعادة التعيين غير صالح أو منتهي الصلاحية",
      });

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const nextPasswordHash = await hashPassword(newPassword);
    const updated = await db.transaction(async (tx) => {
      const resetToken = (
        await tx
          .select()
          .from(passwordResetTokensTable)
          .where(
            and(
              eq(passwordResetTokensTable.tokenHash, tokenHash),
              isNull(passwordResetTokensTable.usedAt),
              gt(passwordResetTokensTable.expiresAt, new Date()),
            ),
          )
      )[0];
      if (!resetToken) return null;
      // Lock accounts before reset-token rows, matching forgot-password's lock
      // order. The later WHERE-guarded UPDATE is still the single-use claim.
      const locked = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, resetToken.userId))
          .for("update")
      )[0];
      if (!locked || !locked.isActive) return null;
      const claimed = await tx
        .update(passwordResetTokensTable)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokensTable.id, resetToken.id),
            isNull(passwordResetTokensTable.usedAt),
            gt(passwordResetTokensTable.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!claimed[0]) return null;
      const row = (
        await tx
          .update(usersTable)
          .set({
            passwordHash: nextPasswordHash,
            mustChangePassword: false,
            // Revoke every existing session — a stolen cookie/token must not
            // survive an account-recovery reset.
            sessionVersion: sql`${usersTable.sessionVersion} + 1`,
          })
          .where(eq(usersTable.id, locked.id))
          .returning()
      )[0];
      if (!row) return null;
      await tx
        .insert(auditLogsTable)
        .values(
          auditEntry(
            row,
            "Reset password via email link",
            "إعادة تعيين كلمة المرور عبر رابط البريد",
            "Account",
            "الحساب",
            req.ip,
          ),
        );
      return row;
    });
    if (!updated) {
      invalid();
      return;
    }
    // A password reset proves email control, not the second factor — 2FA
    // accounts still have to pass the OTP challenge before getting a session.
    if (updated.totpEnabled && !updated.totpSecret) {
      logger.error(
        { userId: updated.id },
        "Blocked post-reset login because the 2FA account state is inconsistent",
      );
      res.status(503).json({
        message:
          "Account security configuration requires administrator attention",
        messageAr: "إعدادات أمان الحساب تحتاج إلى مراجعة المسؤول",
      });
      return;
    }
    if (updated.totpEnabled) {
      respondWithTwoFactorChallenge(updated, res);
      return;
    }
    await issueSession(
      updated,
      req,
      res,
      "Signed in after password reset",
      "تسجيل دخول بعد إعادة تعيين كلمة المرور",
    );
  },
);

export default router;
