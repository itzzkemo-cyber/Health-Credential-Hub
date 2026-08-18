import { Router, type IRouter, type Response } from "express";
import { randomBytes } from "node:crypto";
import { db, usersTable, facilitiesTable, type User } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import {
  signToken,
  signPurposeToken,
  verifyPurposeToken,
  createTwoFactorChallengeToken,
  hashPassword,
  setSessionCookie,
} from "../lib/auth";
import { logAudit, syncExpiryNotifications } from "../lib/helpers";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";

const router: IRouter = Router();
const oauthRateLimit = rateLimit({ name: "google-oauth", max: 20, windowMs: 10 * 60_000 });

// --- Google OAuth (authorization-code flow) ----------------------------------
// GET /auth/google           → redirect to Google's consent screen
// GET /auth/google/callback  → code+state → token exchange → userinfo → session
//
// Implemented directly against Google's OAuth2 endpoints (no passport): the
// app is JWT-based with no server session store, so the strategy machinery
// would add dependencies without adding safety. CSRF on the callback is
// enforced twice — `state` is a signed 10-minute purpose token AND its nonce
// must match the httpOnly cookie set when the flow started, which binds the
// callback to the browser that initiated it.

const NONCE_COOKIE = "healthdocs_oauth_nonce";

function googleConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** First entry of REPLIT_DOMAINS: dev domain in the workspace, the published
 *  domain in production — so the same code yields the right URLs in both. */
function externalDomain(): string | null {
  const first = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return first || null;
}

export function googleRedirectUri(): string | null {
  const domain = externalDomain();
  return domain ? `https://${domain}/api/auth/google/callback` : null;
}

/** Web app base (no trailing slash), e.g. https://<domain>/health-docs */
function webBaseUrl(): string {
  const domain = externalDomain();
  return domain ? `https://${domain}/health-docs` : "/health-docs";
}

function loginErrorRedirect(res: Response, code: string): void {
  res.redirect(`${webBaseUrl()}/login?error=${encodeURIComponent(code)}`);
}

const nonceCookieOptions = {
  httpOnly: true,
  secure: true,
  // Lax is enough (and stricter than None): the callback arrives as a
  // top-level GET navigation from Google, where Lax cookies are sent.
  sameSite: "lax" as const,
  path: "/api/auth/google",
};

router.get("/auth/google", oauthRateLimit, (req, res) => {
  const config = googleConfig();
  const uri = googleRedirectUri();
  if (!config || !uri) {
    loginErrorRedirect(res, "oauth_config");
    return;
  }
  const nonce = randomBytes(16).toString("hex");
  const state = signPurposeToken("oauth_state", 0, { n: nonce }, "10m");
  res.cookie(NONCE_COOKIE, nonce, { ...nonceCookieOptions, maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: uri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

async function fetchGoogleProfile(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GoogleProfile> {
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    throw new Error(`token exchange failed with status ${tokenResp.status}`);
  }
  const tokens = (await tokenResp.json()) as { access_token?: unknown };
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("token response had no access_token");
  }
  // Userinfo over TLS straight from Google — no id_token signature dance.
  const infoResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoResp.ok) {
    throw new Error(`userinfo failed with status ${infoResp.status}`);
  }
  const info = (await infoResp.json()) as Record<string, unknown>;
  return {
    sub: typeof info.sub === "string" ? info.sub : "",
    email: typeof info.email === "string" ? info.email.trim().toLowerCase() : "",
    // Some Google responses stringify the boolean.
    emailVerified: info.email_verified === true || info.email_verified === "true",
    name: typeof info.name === "string" && info.name.trim() ? info.name.trim() : null,
    picture: typeof info.picture === "string" && info.picture ? info.picture : null,
  };
}

/** Match by googleId, else link by verified email, else create an employee. */
async function upsertGoogleUser(
  profile: GoogleProfile,
): Promise<{ user: User; action: "signin" | "linked" | "created" }> {
  const byGoogleId = (
    await db.select().from(usersTable).where(eq(usersTable.googleId, profile.sub))
  )[0];
  if (byGoogleId) return { user: byGoogleId, action: "signin" };

  const byEmail = (
    await db.select().from(usersTable).where(eq(usersTable.email, profile.email))
  )[0];
  if (byEmail) {
    // A different googleId on the row would mean this verified email moved
    // between Google accounts — refuse rather than silently re-link.
    if (byEmail.googleId && byEmail.googleId !== profile.sub) {
      throw new Error("email already linked to a different Google account");
    }
    const linked = (
      await db
        .update(usersTable)
        .set({
          googleId: profile.sub,
          avatarUrl: byEmail.avatarUrl ?? profile.picture,
        })
        .where(eq(usersTable.id, byEmail.id))
        .returning()
    )[0]!;
    return { user: linked, action: "linked" };
  }

  const autoProvisionEnabled =
    process.env.GOOGLE_AUTO_PROVISION_ENABLED === "true" ||
    (process.env.NODE_ENV !== "production" &&
      process.env.GOOGLE_AUTO_PROVISION_ENABLED !== "false");
  if (!autoProvisionEnabled) {
    throw new Error("Google account auto-provisioning is disabled");
  }

  // First facility (lowest id) is the landing spot for self-served Google
  // signups; admins can reassign. Role is hardcoded to employee — privileged
  // roles are only ever granted by an admin.
  const facility = (
    await db.select().from(facilitiesTable).orderBy(asc(facilitiesTable.id)).limit(1)
  )[0];
  if (!facility) throw new Error("no facility exists to place the new user in");
  const name = profile.name ?? profile.email.split("@")[0]!;
  try {
    const created = (
      await db
        .insert(usersTable)
        .values({
          email: profile.email,
          // Google-only account: unguessable placeholder. A real password can
          // be set later via the reset-password flow, after which both
          // methods work side by side.
          passwordHash: await hashPassword(randomBytes(32).toString("hex")),
          name,
          nameAr: name,
          role: "employee",
          facilityId: facility.id,
          googleId: profile.sub,
          avatarUrl: profile.picture,
          isActive: true,
        })
        .returning()
    )[0]!;
    return { user: created, action: "created" };
  } catch (err) {
    // Unique-constraint race (double-submit of the callback): the loser
    // re-reads the row the winner inserted.
    if ((err as { code?: string } | null)?.code === "23505") {
      const existing = (
        await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.googleId, profile.sub))
      )[0];
      if (existing) return { user: existing, action: "signin" };
    }
    throw err;
  }
}

const AUDIT_BY_ACTION: Record<
  "signin" | "linked" | "created",
  { en: string; ar: string }
> = {
  signin: { en: "Signed in (Google)", ar: "تسجيل دخول عبر Google" },
  linked: { en: "Linked Google account and signed in", ar: "ربط حساب Google وتسجيل دخول" },
  created: { en: "Created account (Google)", ar: "إنشاء حساب عبر Google" },
};

router.get("/auth/google/callback", oauthRateLimit, async (req, res) => {
  const config = googleConfig();
  const uri = googleRedirectUri();
  if (!config || !uri) {
    loginErrorRedirect(res, "oauth_config");
    return;
  }
  const nonceCookie = (req.cookies as Record<string, unknown> | undefined)?.[
    NONCE_COOKIE
  ];
  res.clearCookie(NONCE_COOKIE, nonceCookieOptions);

  // The user clicked "cancel" on Google's consent screen.
  if (typeof req.query.error === "string" && req.query.error) {
    loginErrorRedirect(res, "oauth_denied");
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const payload = state ? verifyPurposeToken(state, "oauth_state") : null;
  const nonceOk =
    payload !== null &&
    typeof payload.n === "string" &&
    typeof nonceCookie === "string" &&
    nonceCookie.length > 0 &&
    payload.n === nonceCookie;
  if (!code || !nonceOk) {
    loginErrorRedirect(res, "oauth_state");
    return;
  }

  let profile: GoogleProfile;
  try {
    profile = await fetchGoogleProfile(code, config.clientId, config.clientSecret, uri);
  } catch (err) {
    logger.warn({ err }, "Google OAuth exchange failed");
    loginErrorRedirect(res, "oauth_failed");
    return;
  }
  if (!profile.sub || !profile.email) {
    loginErrorRedirect(res, "oauth_failed");
    return;
  }
  // Linking by email is only safe when Google has verified mailbox ownership.
  if (!profile.emailVerified) {
    loginErrorRedirect(res, "oauth_email_unverified");
    return;
  }

  let user: User;
  let action: "signin" | "linked" | "created";
  try {
    ({ user, action } = await upsertGoogleUser(profile));
  } catch (err) {
    logger.warn({ err }, "Google OAuth account upsert refused");
    loginErrorRedirect(res, "oauth_failed");
    return;
  }
  if (!user.isActive) {
    loginErrorRedirect(res, "oauth_inactive");
    return;
  }

  // Local 2FA still applies — Google only replaces the password factor
  // (mirrors the reset-password flow, which is also 2FA-gated). The token
  // rides the URL fragment: never sent to servers, absent from logs/Referer.
  if (user.totpEnabled && user.totpSecret) {
    const challengeToken = createTwoFactorChallengeToken(user);
    res.redirect(`${webBaseUrl()}/2fa-challenge#ct=${encodeURIComponent(challengeToken)}`);
    return;
  }

  await syncExpiryNotifications(user);
  const audit = AUDIT_BY_ACTION[action];
  await logAudit(user, audit.en, audit.ar, "Session", "الجلسة", undefined, req.ip);
  setSessionCookie(res, signToken(user.id, user.sessionVersion));
  res.redirect(`${webBaseUrl()}/`);
});

export default router;
