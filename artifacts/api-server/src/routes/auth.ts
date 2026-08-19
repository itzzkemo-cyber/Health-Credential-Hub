
import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import {
  db,
  usersTable,
  facilitiesTable,
  passwordResetTokensTable,
  type User,
} from "@workspace/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
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
  hashBackupCode,
  looksLikeBackupCode,
} from "../lib/totp";
import QRCode from "qrcode";
import { serializeUser, logAudit, syncExpiryNotifications } from "../lib/helpers";
import { sessionIssuanceCsrfGuard } from "../lib/csrf";
import { decryptTotpSecret, encryptTotpSecret } from "../lib/totpSecret";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";
import {
  EmailNotConfiguredError,
  isEmailConfigured,
  isFixtureRecipient,
  sendEmail,
} from "../lib/email/sender";
import { getAppBaseUrl, passwordResetEmail } from "../lib/email/templates";

const router: IRouter = Router();
const loginRateLimit = rateLimit({ name: "login", max: 10, windowMs: 10 * 60_000 });
const registrationRateLimit = rateLimit({ name: "register", max: 5, windowMs: 60 * 60_000 });
const recoveryRateLimit = rateLimit({ name: "recovery", max: 5, windowMs: 60 * 60_000 });
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

/**
 * Complete a successful authentication: sync notifications, audit, then issue
 * the session. The token is set as an httpOnly cookie (unreadable by web
 * JavaScript) and also returned in the body for native clients that
 * authenticate with an Authorization: Bearer header. Every route that calls
 * this MUST be registered with `sessionIssuanceCsrfGuard` (login CSRF).
 */
async function issueSession(
  user: User,
  req: Request,
  res: Response,
  actionEn = "Signed in",
  actionAr = "تسجيل دخول",
): Promise<void> {
  await syncExpiryNotifications(user);
  await logAudit(user, actionEn, actionAr, "Session", "الجلسة", undefined, req.ip);
  const token = signToken(user.id, user.sessionVersion);
  setSessionCookie(res, token);
  res.json({ token, user: serializeUser(user) });
}

router.post("/auth/login", loginRateLimit, sessionIssuanceCsrfGuard, async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }
  const normalizedEmail = email.toLowerCase().trim();
  if (
    isDemoAccount(normalizedEmail) &&
    !enabledOutsideProduction("DEMO_LOGIN_ENABLED")
  ) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail));
  const user = rows[0];
  if (!user || !user.isActive) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }
  const ok = await comparePassword(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }
  if (user.totpEnabled && !user.totpSecret) {
    logger.error(
      { userId: user.id },
      "Blocked login because the 2FA account state is inconsistent",
    );
    res.status(503).json({
      message: "Account security configuration requires administrator attention",
      messageAr: "إعدادات أمان الحساب تحتاج إلى مراجعة المسؤول",
    });
    return;
  }
  if (user.totpEnabled) {
    respondWithTwoFactorChallenge(user, res);
    return;
  }
  await issueSession(user, req, res);
});

// Correct password, but the account has 2FA enabled: 202 with a challenge
// token instead of a session (see createTwoFactorChallengeToken).
function respondWithTwoFactorChallenge(user: User, res: Response): void {
  res.status(202).json({
    pending2fa: true,
    challengeToken: createTwoFactorChallengeToken(user),
  });
}

// Server-side allowlist of showcase accounts. Only the role names are known
// to the client; passwords never appear in the frontend bundle.
const DEMO_ACCOUNT_EMAILS: Record<string, string> = {
  system_admin: "admin@healthdocs.sa",
  hospital_admin: "hospital@healthdocs.sa",
  department_manager: "dept@healthdocs.sa",
  supervisor: "supervisor@healthdocs.sa",
  employee: "employee@healthdocs.sa",
};

function enabledOutsideProduction(name: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const value = process.env[name];
  if (value === "true") return true;
  if (value === "false") return false;
  return true;
}

function isDemoAccount(email: string): boolean {
  return Object.values(DEMO_ACCOUNT_EMAILS).includes(email.toLowerCase());
}

router.post("/auth/demo-login", loginRateLimit, sessionIssuanceCsrfGuard, async (req, res) => {
  if (!enabledOutsideProduction("DEMO_LOGIN_ENABLED")) {
    res.status(403).json({ message: "Demo login is disabled" });
    return;
  }
  const { role } = req.body as { role?: string };
  const email = role ? DEMO_ACCOUNT_EMAILS[role] : undefined;
  if (!email) {
    res.status(400).json({ message: "Unknown demo role" });
    return;
  }
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
  const user = rows[0];
  if (!user || !user.isActive) {
    res.status(403).json({ message: "Demo account unavailable" });
    return;
  }
  await issueSession(user, req, res, "Signed in (demo)", "تسجيل دخول (تجريبي)");
});

// Self-registration: anyone can create an *employee* account. The role is
// hardcoded server-side — privileged roles are only ever granted by an admin.
router.post("/auth/register", registrationRateLimit, sessionIssuanceCsrfGuard, async (req, res) => {
  if (!enabledOutsideProduction("SELF_REGISTRATION_ENABLED")) {
    res.status(403).json({
      message: "Self-registration is disabled",
      messageAr: "التسجيل الذاتي غير متاح",
    });
    return;
  }
  const body = req.body as {
    name?: unknown;
    nameAr?: unknown;
    email?: unknown;
    password?: unknown;
    phone?: unknown;
    facilityId?: unknown;
  };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const nameAr = typeof body.nameAr === "string" ? body.nameAr.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const phone =
    typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
  // Strict: only a positive integer sent as an actual JSON number is accepted
  // (a bare Number() coercion would turn true into 1 and null into 0).
  const facilityId =
    typeof body.facilityId === "number" &&
    Number.isInteger(body.facilityId) &&
    body.facilityId > 0
      ? body.facilityId
      : NaN;

  if (!name || !nameAr || !email || !password || !Number.isFinite(facilityId)) {
    res.status(400).json({
      message: "Name (Arabic and English), email, password and facility are required",
      messageAr: "الاسم بالعربية والإنجليزية والبريد وكلمة المرور والمنشأة حقول مطلوبة",
    });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({
      message: "Invalid email address",
      messageAr: "البريد الإلكتروني غير صالح",
    });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({
      message: "Password must be at least 8 characters",
      messageAr: "كلمة المرور يجب ألا تقل عن 8 أحرف",
    });
    return;
  }
  const facility = (
    await db.select().from(facilitiesTable).where(eq(facilitiesTable.id, facilityId))
  )[0];
  if (!facility) {
    res.status(400).json({
      message: "Unknown facility",
      messageAr: "المنشأة المختارة غير معروفة",
    });
    return;
  }
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (existing.length > 0) {
    res.status(409).json({
      message: "Email already in use",
      messageAr: "هذا البريد الإلكتروني مستخدم مسبقاً",
    });
    return;
  }

  let user: User;
  try {
    const inserted = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash: await hashPassword(password),
        name,
        nameAr,
        role: "employee",
        facilityId: facility.id,
        phone,
        isActive: true,
      })
      .returning();
    user = inserted[0]!;
  } catch (err) {
    // Unique-constraint race: two simultaneous registrations with the same
    // email — the check above passed for both, the second insert loses.
    if ((err as { code?: string } | null)?.code === "23505") {
      res.status(409).json({
        message: "Email already in use",
        messageAr: "هذا البريد الإلكتروني مستخدم مسبقاً",
      });
      return;
    }
    throw err;
  }

  await issueSession(user, req, res, "Created account", "إنشاء حساب");
});

router.post("/auth/logout", requireAuth, async (req, res) => {
  const user = getUser(req);
  const updated = (
    await db
      .update(usersTable)
      .set({ sessionVersion: sql`${usersTable.sessionVersion} + 1` })
      .where(eq(usersTable.id, user.id))
      .returning()
  )[0]!;
  // Logout is global for this account: revoke every bearer token/cookie, then
  // clear the current browser cookie as well.
  clearSessionCookie(res);
  await logAudit(
    updated,
    "Signed out",
    "تسجيل خروج",
    "Session",
    "الجلسة",
    undefined,
    req.ip,
  );
  res.json({});
});

router.get("/auth/me", requireAuth, (req, res) => {
  res.json(serializeUser(getUser(req)));
});

router.post("/auth/change-password", requireAuth, changePasswordRateLimit, async (req, res) => {
  const user = getUser(req);
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    res.status(400).json({ message: "Password must be at least 8 characters" });
    return;
  }
  const ok = await comparePassword(currentPassword, user.passwordHash);
  if (!ok) {
    res.status(400).json({ message: "Current password is incorrect" });
    return;
  }
  const updated = (
    await db
      .update(usersTable)
      .set({
        passwordHash: await hashPassword(newPassword),
        // "Log out everywhere": revoke all sessions issued before this change…
        sessionVersion: sql`${usersTable.sessionVersion} + 1`,
      })
      .where(eq(usersTable.id, user.id))
      .returning()
  )[0]!;
  await logAudit(updated, "Changed password", "تغيير كلمة المرور", "Account", "الحساب");
  // …but keep THIS one alive by re-issuing at the new session version.
  const freshToken = signToken(updated.id, updated.sessionVersion);
  setSessionCookie(res, freshToken);
  res.json({ token: freshToken });
});

// --- Two-factor authentication (TOTP) ---------------------------------------

const MAX_CHALLENGE_ATTEMPTS = 5;
const CHALLENGE_STATE_TTL_MS = 6 * 60 * 1000; // outlives the 5m token
// Per-challenge attempt counters + used-token registry, keyed by jti.
// In-memory is fine for a single instance: state loss on restart only means
// a fresh 5-attempt budget for tokens that still expire within minutes.
const challengeAttempts = new Map<string, { count: number; expiresAt: number }>();
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

/**
 * Consume a second factor: either a TOTP code (with atomic replay protection
 * via totp_last_used_step) or a single-use backup code (atomically removed
 * from the jsonb array — concurrent reuse loses on the WHERE guard).
 * Returns the fresh user row on success, null on failure.
 */
async function consumeSecondFactor(user: User, code: string): Promise<User | null> {
  if (!user.totpSecret) return null;
  if (looksLikeBackupCode(code)) {
    const hash = hashBackupCode(code);
    const rows = await db
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
  // Replay guard: each 30s time-step may only ever be accepted once, and only
  // moving forward. The WHERE clause makes concurrent submissions race safely.
  const rows = await db
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

// Step 1 of enabling: generate a secret and hand it back WITHOUT persisting.
// The signed setup token carries the secret so verify-setup can trust it
// unmodified; nothing touches the DB until the user proves their app works.
router.post("/auth/totp/setup", requireAuth, totpSensitiveRateLimit, async (req, res) => {
  const user = getUser(req);
  if (user.totpEnabled) {
    res.status(400).json({
      message: "Two-factor authentication is already enabled",
      messageAr: "المصادقة الثنائية مفعّلة مسبقاً",
    });
    return;
  }
  const secret = generateTotpSecret();
  const otpauthUrl = buildOtpauthUrl(secret, user.email);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 });
  const setupToken = signPurposeToken("totp_setup", user.id, { s: secret }, "10m");
  res.json({ secret, otpauthUrl, qrDataUrl, setupToken });
});

// Step 2 of enabling: first valid OTP activates 2FA and issues backup codes.
router.post("/auth/totp/verify-setup", requireAuth, totpSensitiveRateLimit, async (req, res) => {
  const user = getUser(req);
  const body = req.body as { setupToken?: unknown; code?: unknown };
  const setupToken = typeof body.setupToken === "string" ? body.setupToken : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (user.totpEnabled) {
    res.status(400).json({
      message: "Two-factor authentication is already enabled",
      messageAr: "المصادقة الثنائية مفعّلة مسبقاً",
    });
    return;
  }
  const payload = setupToken ? verifyPurposeToken(setupToken, "totp_setup") : null;
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
  await db
    .update(usersTable)
    .set({
      totpSecret: encryptTotpSecret(secret),
      totpEnabled: true,
      backupCodes: codes.hashes,
      totpLastUsedStep: step,
    })
    .where(eq(usersTable.id, user.id));
  await logAudit(
    user,
    "Enabled two-factor authentication",
    "تفعيل المصادقة الثنائية",
    "Account",
    "الحساب",
    undefined,
    req.ip,
  );
  res.json({ backupCodes: codes.plaintext });
});

// Step 2 of login for 2FA accounts: challenge token + OTP/backup code → session.
router.post("/auth/totp/challenge", loginRateLimit, sessionIssuanceCsrfGuard, async (req, res) => {
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
    const rows = Number.isFinite(userId)
      ? await db.select().from(usersTable).where(eq(usersTable.id, userId))
      : [];
    const user = rows[0];
    // The version pin voids challenges issued before a password reset/change.
    if (
      !user ||
      !user.isActive ||
      !user.totpEnabled ||
      !user.totpSecret ||
      (typeof payload.v === "number" ? payload.v : -1) !== user.sessionVersion
    ) {
      expired();
      return;
    }

    const fresh = code ? await consumeSecondFactor(user, code) : null;
    if (!fresh) {
      res.status(401).json({
        code: "invalid_code",
        message: "The verification code is incorrect",
        messageAr: "رمز التحقق غير صحيح",
      });
      return;
    }
    challengeAttempts.delete(jti);
    succeeded = true;
    await issueSession(fresh, req, res, "Signed in (2FA)", "تسجيل دخول (تحقق ثنائي)");
  } finally {
    // Any non-success exit releases the in-flight claim so the user can retry
    // with the same challenge; the attempt above stays counted either way.
    if (!succeeded) usedChallenges.delete(jti);
  }
});

// Disabling requires password AND a second factor — a stolen password alone
// must never be enough to switch the protection off.
router.delete("/auth/totp/disable", requireAuth, totpSensitiveRateLimit, async (req, res) => {
  const user = getUser(req);
  const body = req.body as { currentPassword?: unknown; code?: unknown };
  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!user.totpEnabled) {
    res.status(400).json({
      message: "Two-factor authentication is not enabled",
      messageAr: "المصادقة الثنائية غير مفعّلة",
    });
    return;
  }
  if (!currentPassword || !(await comparePassword(currentPassword, user.passwordHash))) {
    res.status(400).json({
      code: "wrong_password",
      message: "Current password is incorrect",
      messageAr: "كلمة المرور الحالية غير صحيحة",
    });
    return;
  }
  const fresh = code ? await consumeSecondFactor(user, code) : null;
  if (!fresh) {
    res.status(400).json({
      code: "invalid_code",
      message: "The verification code is incorrect",
      messageAr: "رمز التحقق غير صحيح",
    });
    return;
  }
  await db
    .update(usersTable)
    .set({
      totpSecret: null,
      totpEnabled: false,
      backupCodes: null,
      totpLastUsedStep: null,
    })
    .where(eq(usersTable.id, user.id));
  await logAudit(
    user,
    "Disabled two-factor authentication",
    "إلغاء تفعيل المصادقة الثنائية",
    "Account",
    "الحساب",
    undefined,
    req.ip,
  );
  res.json({});
});

// Fresh batch of backup codes (invalidates all previous ones). Requires
// password + second factor, same bar as disabling.
router.post("/auth/totp/regenerate-backup", requireAuth, totpSensitiveRateLimit, async (req, res) => {
  const user = getUser(req);
  const body = req.body as { currentPassword?: unknown; code?: unknown };
  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!user.totpEnabled || !user.totpSecret) {
    res.status(400).json({
      message: "Two-factor authentication is not enabled",
      messageAr: "المصادقة الثنائية غير مفعّلة",
    });
    return;
  }
  if (!currentPassword || !(await comparePassword(currentPassword, user.passwordHash))) {
    res.status(400).json({
      code: "wrong_password",
      message: "Current password is incorrect",
      messageAr: "كلمة المرور الحالية غير صحيحة",
    });
    return;
  }
  const fresh = code ? await consumeSecondFactor(user, code) : null;
  if (!fresh) {
    res.status(400).json({
      code: "invalid_code",
      message: "The verification code is incorrect",
      messageAr: "رمز التحقق غير صحيح",
    });
    return;
  }
  const codes = generateBackupCodes();
  await db
    .update(usersTable)
    .set({ backupCodes: codes.hashes })
    .where(eq(usersTable.id, user.id));
  await logAudit(
    user,
    "Regenerated 2FA backup codes",
    "إعادة توليد الرموز الاحتياطية للمصادقة الثنائية",
    "Account",
    "الحساب",
    undefined,
    req.ip,
  );
  res.json({ backupCodes: codes.plaintext });
});

// Admin recovery path: an account admin can switch 2FA off for a locked-out
// user (no password/OTP — the admin's own authenticated role is the authority).
router.post(
  "/auth/totp/admin-disable",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  totpSensitiveRateLimit,
  async (req, res) => {
    const admin = getUser(req);
    const body = req.body as { userId?: unknown };
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
    const target = (
      await db.select().from(usersTable).where(eq(usersTable.id, targetId))
    )[0];
    // Hospital admins act within their own facility; system admins anywhere.
    if (
      !target ||
      (admin.role !== "system_admin" && target.facilityId !== admin.facilityId)
    ) {
      res.status(404).json({
        message: "Employee not found",
        messageAr: "الموظف غير موجود",
      });
      return;
    }
    // The recovery path must never become a self-service bypass of the
    // password+second-factor requirement in /auth/totp/disable.
    if (target.id === admin.id) {
      res.status(403).json({
        message:
          "Use the regular disable flow (password + code) for your own account",
        messageAr:
          "لإلغاء التفعيل لحسابك استخدم المسار الاعتيادي (كلمة المرور + رمز التحقق)",
      });
      return;
    }
    // Rank guard: only a system admin may reset another system admin.
    if (target.role === "system_admin" && admin.role !== "system_admin") {
      res.status(404).json({
        message: "Employee not found",
        messageAr: "الموظف غير موجود",
      });
      return;
    }
    if (!target.totpEnabled) {
      res.status(400).json({
        message: "Two-factor authentication is not enabled for this account",
        messageAr: "المصادقة الثنائية غير مفعّلة لهذا الحساب",
      });
      return;
    }
    await db
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
      .where(eq(usersTable.id, target.id));
    await logAudit(
      admin,
      `Disabled two-factor authentication for ${target.name}`,
      `إلغاء تفعيل المصادقة الثنائية للموظف ${target.nameAr}`,
      "Account",
      "الحساب",
      undefined,
      req.ip,
    );
    res.json({});
  },
);

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // reset links are valid for 1 hour

router.post("/auth/forgot-password", recoveryRateLimit, async (req, res) => {
  const body = req.body as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  // Uniform 200 regardless of outcome (no account enumeration) — and respond
  // *before* the lookup/email work so response timing is uniform too.
  res.json({});
  if (!email) return;
  try {
    const rows = await db.select().from(usersTable).where(eq(usersTable.email, email));
    const user = rows[0];
    if (!user || !user.isActive) return;

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    // Single-active-link policy: requesting a new link voids older unused ones.
    await db
      .update(passwordResetTokensTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokensTable.userId, user.id),
          isNull(passwordResetTokensTable.usedAt),
        ),
      );
    await db.insert(passwordResetTokensTable).values({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    });
    await logAudit(
      user,
      "Requested password reset",
      "طلب إعادة تعيين كلمة المرور",
      "Account",
      "الحساب",
      undefined,
      req.ip,
    );

    const base = getAppBaseUrl();
    if (!base || !isEmailConfigured() || isFixtureRecipient(user.email)) {
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
        resetUrl: `${base}reset-password?token=${rawToken}`,
      }),
    });
    logger.info({ userId: user.id }, "Password reset email sent");
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      logger.warn("Password reset email skipped — provider not configured");
      return;
    }
    // Response already sent; log for operators, never leak to the caller.
    logger.error({ err }, "Password reset processing failed");
  }
});

router.post("/auth/reset-password", recoveryRateLimit, sessionIssuanceCsrfGuard, async (req, res) => {
  const body = req.body as { token?: unknown; newPassword?: unknown };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!token || !newPassword || newPassword.length < 8) {
    res.status(400).json({
      code: "weak_password",
      message: "A reset token and a password of at least 8 characters are required",
      messageAr: "رمز إعادة التعيين وكلمة مرور لا تقل عن 8 أحرف مطلوبان",
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
  // Atomic claim: flipping usedAt in the WHERE-guarded UPDATE means a token
  // can only ever be consumed once, even under concurrent submissions.
  const claimed = await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokensTable.tokenHash, tokenHash),
        isNull(passwordResetTokensTable.usedAt),
        gt(passwordResetTokensTable.expiresAt, new Date()),
      ),
    )
    .returning();
  const claimedToken = claimed[0];
  if (!claimedToken) {
    invalid();
    return;
  }
  const user = (
    await db.select().from(usersTable).where(eq(usersTable.id, claimedToken.userId))
  )[0];
  if (!user || !user.isActive) {
    invalid();
    return;
  }
  const updated = (
    await db
      .update(usersTable)
      .set({
        passwordHash: await hashPassword(newPassword),
        // Revoke every existing session — a stolen cookie/token must not
        // survive an account-recovery reset.
        sessionVersion: sql`${usersTable.sessionVersion} + 1`,
      })
      .where(eq(usersTable.id, user.id))
      .returning()
  )[0]!;
  await logAudit(
    updated,
    "Reset password via email link",
    "إعادة تعيين كلمة المرور عبر رابط البريد",
    "Account",
    "الحساب",
    undefined,
    req.ip,
  );
  // A password reset proves email control, not the second factor — 2FA
  // accounts still have to pass the OTP challenge before getting a session.
  if (updated.totpEnabled && !updated.totpSecret) {
    logger.error(
      { userId: updated.id },
      "Blocked post-reset login because the 2FA account state is inconsistent",
    );
    res.status(503).json({
      message: "Account security configuration requires administrator attention",
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
});

export default router;
