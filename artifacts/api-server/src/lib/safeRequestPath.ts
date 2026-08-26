const PRIVATE_OBJECT_PATH = /^(\/api\/storage\/objects\/).+$/i;
const PUBLIC_VERIFICATION_PATH =
  /^(\/api\/credentials\/)[^/]+(\/verify\/?)$/i;

/**
 * Return a bounded request path that is safe for operational logs.
 *
 * Query strings are never logged. Private object identifiers and public QR
 * verification tokens are also removed because both are sensitive correlators
 * even though the corresponding routes still enforce their own access policy.
 */
export function safeRequestPath(rawUrl: string | undefined): string | undefined {
  if (rawUrl == null) return undefined;

  const requestPath = rawUrl.split("?", 1)[0];
  if (PRIVATE_OBJECT_PATH.test(requestPath)) {
    return requestPath.replace(PRIVATE_OBJECT_PATH, "$1[redacted]");
  }
  if (PUBLIC_VERIFICATION_PATH.test(requestPath)) {
    return requestPath.replace(
      PUBLIC_VERIFICATION_PATH,
      "$1[redacted]$2",
    );
  }
  return requestPath;
}
