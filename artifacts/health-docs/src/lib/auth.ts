// Session model: the API sets an httpOnly cookie on login, so the auth token
// is never stored in — or readable from — JavaScript and XSS cannot
// exfiltrate it. The browser attaches the cookie to API calls automatically.
// localStorage keeps only a non-sensitive cache of the user's own profile so
// the UI can boot instantly; the cookie is the credential and the server
// remains the source of truth (requests 401 when it expires).

export const USER_KEY = 'healthdocs_auth_user';

/** Storage key used by older builds that kept the raw bearer token in localStorage. */
const LEGACY_TOKEN_KEY = 'healthdocs_auth_token';

// One-time migration: older builds stored the token in localStorage and have
// no session cookie. Drop the token and the stale profile cache so those
// sessions land on the login page instead of a dashboard full of 401s.
if (localStorage.getItem(LEGACY_TOKEN_KEY) !== null) {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function setAuthSession(user: unknown) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuthSession() {
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

export function getAuthUser() {
  const userStr = localStorage.getItem(USER_KEY);
  if (!userStr) return null;
  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getAuthUser() !== null;
}
