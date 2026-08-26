import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import type { CookieOptions, Request, Response, NextFunction } from "express";
import { db, usersTable, type User } from "@workspace/db";
import { eq } from "drizzle-orm";

function requireSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    throw new Error(
      "SESSION_SECRET environment variable is required — refusing to start with an insecure default",
    );
  }
  if (process.env.NODE_ENV === "production" && s.length < 32) {
    throw new Error(
      "SESSION_SECRET must contain at least 32 characters in production",
    );
  }
  return s;
}
const SECRET: string = requireSecret();
const TOKEN_ISSUER = "health-credential-hub";
const TOKEN_AUDIENCE = "health-credential-hub-clients";
const JWT_OPTIONS = {
  algorithm: "HS256" as const,
  issuer: TOKEN_ISSUER,
  audience: TOKEN_AUDIENCE,
};

export interface AuthedRequest extends Request {
  user?: User;
}

export function signToken(userId: number, sessionVersion: number): string {
  return jwt.sign({ sub: String(userId), v: sessionVersion }, SECRET, {
    ...JWT_OPTIONS,
    expiresIn: "7d",
  });
}

// --- Purpose-scoped tokens ---------------------------------------------------
// Short-lived JWTs for multi-step auth flows (2FA login challenge, TOTP
// setup). They carry a `purpose` claim, and requireAuth refuses any token
// that has one — possessing a challenge token must never grant API access.

export type TokenPurpose = "2fa_challenge" | "totp_setup";

export function signPurposeToken(
  purpose: TokenPurpose,
  userId: number,
  claims: Record<string, unknown>,
  expiresIn: "5m" | "10m",
): string {
  return jwt.sign({ sub: String(userId), purpose, ...claims }, SECRET, {
    ...JWT_OPTIONS,
    expiresIn,
  });
}

/**
 * Correct first factor, but the account has 2FA enabled: no session yet.
 * The returned 5-minute challenge token is exchanged at /auth/totp/challenge
 * together with a valid OTP or backup code for a real session. The embedded
 * `v` pins the session version so a concurrent password change voids the
 * challenge, and `jti` lets the server throttle and single-use it.
 */
export function createTwoFactorChallengeToken(user: User): string {
  return signPurposeToken(
    "2fa_challenge",
    user.id,
    { v: user.sessionVersion, jti: randomBytes(8).toString("hex") },
    "5m",
  );
}

export function verifyPurposeToken(
  token: string,
  purpose: TokenPurpose,
): (Record<string, unknown> & { sub?: string }) | null {
  try {
    const payload = jwt.verify(token, SECRET, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
    if (typeof payload !== "object" || payload === null) return null;
    if ((payload as { purpose?: unknown }).purpose !== purpose) return null;
    return payload as Record<string, unknown> & { sub?: string };
  } catch {
    return null;
  }
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export function comparePassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function getUser(req: Request): User {
  const user = (req as AuthedRequest).user;
  if (!user) throw new Error("User not attached to request");
  return user;
}

// --- Session cookie ---------------------------------------------------------
// The web app authenticates with an httpOnly cookie. Session JWTs are never
// returned in response bodies, so browser JavaScript cannot read them.
//
// SameSite defaults to Lax in production because the web app and API share an
// origin. An explicitly trusted cross-origin web deployment can opt into None.
// CSRF is instead enforced by csrfOriginGuard (first-party Origin required on
// cookie-authenticated mutations) plus the CORS allowlist. SameSite=None
// always requires the Secure attribute.

export const SESSION_COOKIE = "healthdocs_session";
// Keep in sync with the `expiresIn` used by signToken.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sessionCookieOptions(): CookieOptions {
  const configured = process.env.SESSION_COOKIE_SAME_SITE?.toLowerCase();
  if (configured && !["strict", "lax", "none"].includes(configured)) {
    throw new Error("SESSION_COOKIE_SAME_SITE must be strict, lax, or none");
  }
  const sameSite = (configured ??
    (process.env.NODE_ENV === "production" ? "lax" : "none")) as
    | "strict"
    | "lax"
    | "none";
  return {
    httpOnly: true,
    sameSite,
    secure: process.env.NODE_ENV === "production" || sameSite === "none",
    path: "/",
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    ...sessionCookieOptions(),
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
}

function extractToken(req: Request): string | null {
  // An explicit Authorization header (native clients) wins over the ambient
  // session cookie (web app).
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const cookieToken = (req.cookies as Record<string, unknown> | undefined)?.[
    SESSION_COOKIE
  ];
  return typeof cookieToken === "string" && cookieToken ? cookieToken : null;
}

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  "/api/auth/me",
  "/api/auth/change-password",
  "/api/auth/logout",
]);

function canAccessWhilePasswordChangeRequired(req: Request): boolean {
  // originalUrl retains the app-level /api mount point. Remove only the query
  // string and require an exact path match so suffixes/trailing slashes cannot
  // expand this narrow recovery allowlist.
  const requestPath = req.originalUrl.split("?", 1)[0];
  return PASSWORD_CHANGE_ALLOWED_PATHS.has(requestPath);
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  try {
    const payload = jwt.verify(token, SECRET, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    }) as {
      sub?: string;
      v?: number;
      purpose?: string;
    };
    // Purpose-scoped tokens (2FA challenge, TOTP setup) are not sessions.
    if (payload.purpose) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const id = Number(payload.sub);
    if (!Number.isFinite(id)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, id));
    const user = rows[0];
    if (!user || !user.isActive) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    // Session-version check: bumping users.session_version (password reset or
    // change) instantly revokes every previously issued token. Tokens minted
    // before this claim existed carry no `v` and count as version 0.
    if ((typeof payload.v === "number" ? payload.v : 0) !== user.sessionVersion) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    (req as AuthedRequest).user = user;
    if (
      user.mustChangePassword &&
      !canAccessWhilePasswordChangeRequired(req)
    ) {
      res.status(403).json({
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "You must change your temporary password before continuing",
        messageAr: "يجب تغيير كلمة المرور المؤقتة قبل المتابعة",
      });
      return;
    }
    next();
  } catch {
    res.status(401).json({ message: "Unauthorized" });
  }
}

export function requireRole(...roles: User["role"][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    next();
  };
}

export const MANAGER_ROLES: User["role"][] = [
  "supervisor",
  "department_manager",
  "hospital_admin",
  "system_admin",
];

export const ADMIN_ROLES: User["role"][] = ["hospital_admin", "system_admin"];
