import type { User } from "@workspace/api-client-react";

// Session model: the API sets an httpOnly cookie on login, so JavaScript never
// reads or persists the session credential. The current user is kept only in
// page memory and is rebuilt from /api/auth/me on every application boot.
// Employee profile data must not survive a tab close, reload, or browser
// restart in localStorage.

export const USER_KEY = "healthdocs_auth_user";

/** Storage key used by older builds that kept the raw bearer token in localStorage. */
const LEGACY_TOKEN_KEY = "healthdocs_auth_token";

let currentUser: User | null = null;

function clearLegacyPersistedAuth() {
  try {
    if (typeof globalThis.localStorage === "undefined") return;
    globalThis.localStorage.removeItem(USER_KEY);
    globalThis.localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // Storage can be unavailable under strict browser privacy policies. Auth
    // remains fail-closed because page memory starts without a user.
  }
}

// Remove both historical browser-auth values on every boot. A legacy cached
// profile is never enough to establish an authenticated UI session.
clearLegacyPersistedAuth();

export function setAuthSession(user: unknown) {
  // All call sites receive this value from generated, server-backed auth
  // responses (or update one field on that same object).
  currentUser = user as User;
}

export function clearAuthSession() {
  currentUser = null;
  clearLegacyPersistedAuth();
}

export function getAuthUser() {
  // Preserve the established consumer surface while the canonical in-memory
  // value remains typed internally.
  return currentUser as any;
}

export function isAuthenticated(): boolean {
  return currentUser !== null;
}
