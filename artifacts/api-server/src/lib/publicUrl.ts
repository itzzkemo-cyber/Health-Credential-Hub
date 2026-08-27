/** Canonical browser origin, without a trailing slash. */
export function getPublicAppUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env.PUBLIC_APP_URL?.trim();
  const value = configured ?? "";
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("PUBLIC_APP_URL must use HTTP or HTTPS");
    }
    if (env.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error("PUBLIC_APP_URL must use HTTPS in production");
    }
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("PUBLIC_APP_URL must be a bare origin");
    }
    return url.origin;
  } catch (error) {
    throw new Error("PUBLIC_APP_URL must be a valid absolute URL", { cause: error });
  }
}
