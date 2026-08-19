interface ResetTokenLocation {
  href: string;
  pathname: string;
}

interface ResetTokenHistory {
  state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * Read a password-reset token into caller-owned memory, then immediately
 * remove the complete query string and fragment from the visible URL.
 * Fragment delivery is preferred because fragments are not sent in HTTP
 * requests; query support remains only for previously issued links.
 */
export function consumeResetToken(
  location: ResetTokenLocation,
  history: ResetTokenHistory,
): string {
  const url = new URL(location.href);
  const fragmentToken = new URLSearchParams(url.hash.slice(1)).get("token");
  const token = fragmentToken || url.searchParams.get("token") || "";

  history.replaceState(history.state, "", location.pathname);
  return token;
}
