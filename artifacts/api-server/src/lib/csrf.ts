import type { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE } from "./auth";

// First-party browser origins: the workspace/production web domains plus the
// Expo dev origin. Used both by CORS (read permission) and by the CSRF guards
// below (write permission). Requests without an Origin header (curl, native
// mobile apps) are not browser CSRF vectors and are never blocked here.
export const allowedOrigins = new Set<string>(
  [
    ...(process.env.REPLIT_DOMAINS ?? "").split(","),
    process.env.REPLIT_EXPO_DEV_DOMAIN ?? "",
  ]
    .map((domain) => domain.trim())
    .filter(Boolean)
    .map((domain) => `https://${domain}`),
);

function isTrustedBrowserOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
  // Local tooling (screenshots, browser tests) hits the app via localhost in
  // development only; production stays strict.
  if (process.env.NODE_ENV !== "production") {
    try {
      const { protocol, hostname } = new URL(origin);
      if (
        (protocol === "http:" || protocol === "https:") &&
        (hostname === "localhost" || hostname === "127.0.0.1")
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function isSafeMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/** Send 403 and return true when a foreign browser Origin is present. */
function rejectForeignOrigin(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (origin && !isTrustedBrowserOrigin(origin)) {
    res.status(403).json({ message: "Cross-origin request rejected" });
    return true;
  }
  return false;
}

// CSRF defense: the session cookie is SameSite=None (the workspace preview
// iframe is cross-site, Strict/Lax cookies don't work there), so this guard is
// the primary protection. Unsafe methods that ride the ambient session cookie
// must present a first-party Origin when one is sent. Browsers always attach
// Origin to cross-origin POSTs (including plain <form> submissions), so a
// foreign or "null" Origin is rejected. Bearer-authenticated requests are not
// CSRF vectors and pass through. JSON-only body parsing (no urlencoded) closes
// the classic <form> vector as well.
export function csrfOriginGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isSafeMethod(req.method)) {
    next();
    return;
  }
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const usesSessionCookie = typeof cookies?.[SESSION_COOKIE] === "string";
  const usesBearer = req.headers.authorization?.startsWith("Bearer ") ?? false;
  if (!usesSessionCookie || usesBearer) {
    next();
    return;
  }
  if (rejectForeignOrigin(req, res)) return;
  next();
}

// Login-CSRF defense for endpoints that ISSUE a session cookie (login,
// demo-login): those carry no cookie yet, so csrfOriginGuard cannot see them.
// Attached directly to the routes — not matched by path string — so
// trailing-slash or case variants of the URL can never bypass it.
export function sessionIssuanceCsrfGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isSafeMethod(req.method)) {
    next();
    return;
  }
  if (rejectForeignOrigin(req, res)) return;
  next();
}
