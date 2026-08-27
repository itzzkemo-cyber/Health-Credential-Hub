export const OCR_UNAVAILABLE_CODE = "OCR_UNAVAILABLE" as const;

export type OcrOperationalReadiness =
  "disabled" | "configured" | "misconfigured";

export interface OcrConfig {
  enabled: boolean;
  facilityAllowlist: readonly number[];
}

function readFacilityAllowlist(env: NodeJS.ProcessEnv): readonly number[] {
  const raw = env.OCR_FACILITY_ALLOWLIST?.trim();
  if (!raw) {
    throw new Error("OCR_FACILITY_ALLOWLIST is required when OCR is enabled");
  }

  const parts = raw.split(",").map((value) => value.trim());
  if (parts.length > 500 || parts.some((value) => !/^[1-9]\d*$/.test(value))) {
    throw new Error(
      "OCR_FACILITY_ALLOWLIST must contain 1-500 positive integer IDs",
    );
  }

  const facilities = [...new Set(parts.map(Number))];
  if (facilities.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(
      "OCR_FACILITY_ALLOWLIST must contain 1-500 positive integer IDs",
    );
  }
  return facilities;
}

function readProviderHostAllowlist(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env.OCR_PROVIDER_HOST_ALLOWLIST?.trim();
  if (!raw) {
    throw new Error(
      "OCR_PROVIDER_HOST_ALLOWLIST is required when OCR is enabled",
    );
  }

  const hosts = raw
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/\.$/, ""));
  if (
    hosts.length > 20 ||
    hosts.some(
      (host) =>
        !host ||
        host.includes("*") ||
        host.includes("/") ||
        host.includes(":") ||
        !/^[a-z0-9.-]+$/.test(host),
    )
  ) {
    throw new Error(
      "OCR_PROVIDER_HOST_ALLOWLIST must contain exact hostnames without wildcards, schemes, ports, or paths",
    );
  }
  return [...new Set(hosts)];
}

function validateProviderDestination(env: NodeJS.ProcessEnv): void {
  const rawBaseUrl = env.AI_INTEGRATIONS_GEMINI_BASE_URL?.trim();
  const apiKey = env.AI_INTEGRATIONS_GEMINI_API_KEY?.trim();
  if (!rawBaseUrl || !apiKey) {
    throw new Error(
      "Enabled OCR requires AI_INTEGRATIONS_GEMINI_BASE_URL and AI_INTEGRATIONS_GEMINI_API_KEY",
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error("AI_INTEGRATIONS_GEMINI_BASE_URL must be a valid URL");
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_BASE_URL must use HTTPS and contain no credentials, query, or fragment",
    );
  }

  const allowedHosts = readProviderHostAllowlist(env);
  const providerHost = baseUrl.hostname.toLowerCase().replace(/\.$/, "");
  if (!allowedHosts.includes(providerHost)) {
    throw new Error(
      "AI_INTEGRATIONS_GEMINI_BASE_URL hostname is not in OCR_PROVIDER_HOST_ALLOWLIST",
    );
  }
}

/**
 * OCR is always opt-in. Unknown flag values are rejected so an operator typo
 * is visible in readiness while the request path remains closed.
 */
export function readOcrConfig(env: NodeJS.ProcessEnv = process.env): OcrConfig {
  const flag = env.OCR_ENABLED?.trim().toLowerCase();
  if (flag == null || flag === "" || flag === "false") {
    return { enabled: false, facilityAllowlist: [] };
  }
  if (flag !== "true") {
    throw new Error("OCR_ENABLED must be true or false");
  }

  const facilityAllowlist = readFacilityAllowlist(env);
  validateProviderDestination(env);
  return { enabled: true, facilityAllowlist };
}

export function getOcrOperationalReadiness(
  env: NodeJS.ProcessEnv = process.env,
): OcrOperationalReadiness {
  try {
    return readOcrConfig(env).enabled ? "configured" : "disabled";
  } catch {
    return "misconfigured";
  }
}

export function isOcrEnabledForFacility(
  facilityId: number,
  config: OcrConfig,
): boolean {
  return config.enabled && config.facilityAllowlist.includes(facilityId);
}
