import { isIP } from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/**
 * Resolve the network interface that Express may bind to.
 *
 * Development defaults to loopback so a local checkout is not accidentally
 * exposed to the LAN. Production must opt in explicitly: Cloud Run and OCI
 * containers use 0.0.0.0, while a Cloudflare Tunnel origin uses 127.0.0.1.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BIND_HOST?.trim();
  if (!configured) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "BIND_HOST is required in production (use 127.0.0.1 for a local tunnel or 0.0.0.0 in a container)",
      );
    }
    return "127.0.0.1";
  }

  if (
    !LOOPBACK_HOSTS.has(configured) &&
    !WILDCARD_HOSTS.has(configured) &&
    isIP(configured) === 0
  ) {
    throw new Error(
      "BIND_HOST must be an IP address; hostnames and unresolved interfaces are not allowed",
    );
  }

  return configured;
}

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}
