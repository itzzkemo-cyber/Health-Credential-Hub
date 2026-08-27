/** Canonical browser URL, without a trailing slash. */
export function getPublicAppUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PUBLIC_APP_URL?.trim();
  const value = configured ?? "";
  if (!value) return null;
  try {
    const url = new URL(value);
    if (env.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error("PUBLIC_APP_URL must use HTTPS in production");
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    throw new Error("PUBLIC_APP_URL must be a valid absolute URL", { cause: error });
  }
}
