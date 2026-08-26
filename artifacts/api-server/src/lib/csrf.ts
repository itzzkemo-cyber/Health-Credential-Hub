import type { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE } from "./auth";

// First-party browser origins: the workspace/production web domains plus the
// trusted web origin. Used both by CORS (read permission) and by the CSRF guards
// below (write permission). Requests without an Origin header (curl, native
// mobile apps) are not browser CSRF vectors and are never blocked here.
function normalizeOrigin(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const allowedOrigins = new Set<string>(
  [
    ...(process.env.APP_ORIGINS ?? "").split(","),
  ]
    .map(normalizeOrigin)
    .filter((origin): origin is string => origin !== null),
);

function isSameRequestOrigin(req: Request, origin: string): boolean {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
    ?.split(",", 1)[0]
    .trim() || req.get("host");
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
    ?.split(",", 1)[0]
    .trim() || req.protocol;
  if (!host || (protocol !== "http" && protocol !== "https")) return false;
  return origin === `${protocol}://${host}`;
}

function isTrustedBrowserOrigin(req: Request, origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
  if (isSameRequestOrigin(req, origin)) return true;
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
  if (origin && !isTrustedBrowserOrigin(req, origin)) {
    res.status(403).json({ message: "Cross-origin request rejected" });
    return true;
  }
  return false;
}

function rejectMissingClientMarker(req: Request, res: Response): boolean {
  if (req.get("X-Requested-With") !== "HealthCredentialHub") {
    res.status(403).json({ message: "Request verification failed" });
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
  if (rejectMissingClientMarker(req, res)) return;
  next();
}

// Login-CSRF defense for endpoints that issue a session cookie. These requests
// carry no cookie yet, so csrfOriginGuard cannot see them.
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
  if (rejectMissingClientMarker(req, res)) return;
  next();
}
