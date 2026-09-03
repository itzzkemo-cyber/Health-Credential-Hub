export interface AutomationConfig {
  enabled: boolean;
  facilityAllowlist: readonly number[];
  requirePublicAddress: boolean;
  webhookUrl?: URL;
  secret?: Buffer;
  headerAuthSecret?: string;
  timeoutMs: number;
  maxAttempts: number;
  batchSize: number;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  retentionDays: number;
  pendingMaxAgeDays: number;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  maxAttempts: 8,
  batchSize: 25,
  pollIntervalMs: 30_000,
  lockTimeoutMs: 5 * 60_000,
  retentionDays: 30,
  pendingMaxAgeDays: 7,
} as const;

export function isAutomationOutboxEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env.AUTOMATION_OUTBOX_ENABLED?.trim().toLowerCase();
  if (flag == null || flag === "" || flag === "false" || flag === "0") {
    return false;
  }
  if (flag === "true" || flag === "1") return true;
  throw new Error("AUTOMATION_OUTBOX_ENABLED must be true or false");
}

/**
 * Explicit tenant routing boundary for the single-controller webhook. The
 * outbox and worker both fail closed when event production is enabled without
 * a reviewed facility list.
 */
export function readAutomationFacilityAllowlist(
  env: NodeJS.ProcessEnv = process.env,
  required = isAutomationOutboxEnabled(env),
): readonly number[] {
  const raw = env.AUTOMATION_FACILITY_ALLOWLIST?.trim();
  if (!raw) {
    if (required) {
      throw new Error(
        "AUTOMATION_FACILITY_ALLOWLIST is required when automation is enabled",
      );
    }
    return [];
  }
  const parts = raw.split(",").map((value) => value.trim());
  if (parts.length > 500 || parts.some((value) => !/^[1-9]\d*$/.test(value))) {
    throw new Error(
      "AUTOMATION_FACILITY_ALLOWLIST must contain 1-500 positive integer IDs",
    );
  }
  const facilities = [...new Set(parts.map(Number))];
  if (facilities.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(
      "AUTOMATION_FACILITY_ALLOWLIST must contain 1-500 positive integer IDs",
    );
  }
  return facilities;
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function decodeSecret(raw: string, name: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    throw new Error(
      `${name} must be canonical Base64 for at least 32 random bytes`,
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length < 32 || decoded.toString("base64") !== raw) {
    throw new Error(
      `${name} must be canonical Base64 for at least 32 random bytes`,
    );
  }
  return decoded;
}

function readWebhookHostAllowlist(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env.AUTOMATION_WEBHOOK_HOST_ALLOWLIST?.trim();
  if (!raw) {
    throw new Error(
      "AUTOMATION_WEBHOOK_HOST_ALLOWLIST is required when the webhook is enabled",
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
      "AUTOMATION_WEBHOOK_HOST_ALLOWLIST must contain exact hostnames without wildcards, schemes, ports, or paths",
    );
  }
  return [...new Set(hosts)];
}

export function readAutomationConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutomationConfig {
  const flag = env.AUTOMATION_WEBHOOK_ENABLED?.trim().toLowerCase();
  if (flag == null || flag === "" || flag === "false" || flag === "0") {
    return {
      enabled: false,
      facilityAllowlist: [],
      requirePublicAddress: false,
      ...DEFAULTS,
    };
  }
  if (flag !== "true" && flag !== "1") {
    throw new Error("AUTOMATION_WEBHOOK_ENABLED must be true or false");
  }
  if (!isAutomationOutboxEnabled(env)) {
    throw new Error(
      "AUTOMATION_WEBHOOK_ENABLED requires AUTOMATION_OUTBOX_ENABLED=true",
    );
  }
  if (env.AUTOMATION_WEBHOOK_MODE !== "SINGLE_CONTROLLER") {
    throw new Error(
      "AUTOMATION_WEBHOOK_MODE must be SINGLE_CONTROLLER when the webhook is enabled",
    );
  }
  const facilityAllowlist = readAutomationFacilityAllowlist(env, true);

  const rawUrl = env.AUTOMATION_WEBHOOK_URL;
  const rawSecret = env.AUTOMATION_WEBHOOK_SECRET;
  const rawHeaderAuthSecret = env.AUTOMATION_WEBHOOK_HEADER_AUTH_SECRET;
  if (!rawUrl || !rawSecret || !rawHeaderAuthSecret) {
    throw new Error(
      "Enabled automation requires AUTOMATION_WEBHOOK_URL, AUTOMATION_WEBHOOK_SECRET, and AUTOMATION_WEBHOOK_HEADER_AUTH_SECRET",
    );
  }
  const webhookUrl = new URL(rawUrl);
  if (webhookUrl.username || webhookUrl.password || webhookUrl.hash) {
    throw new Error(
      "AUTOMATION_WEBHOOK_URL must not contain credentials or a fragment",
    );
  }
  const production = env.NODE_ENV === "production";
  const webhookHost = webhookUrl.hostname.toLowerCase().replace(/\.$/, "");
  const allowedHosts = readWebhookHostAllowlist(env);
  if (!allowedHosts.includes(webhookHost)) {
    throw new Error(
      "AUTOMATION_WEBHOOK_URL hostname is not in AUTOMATION_WEBHOOK_HOST_ALLOWLIST",
    );
  }
  const localHttp =
    !production &&
    webhookUrl.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(webhookUrl.hostname);
  if (webhookUrl.protocol !== "https:" && !localHttp) {
    throw new Error(
      "AUTOMATION_WEBHOOK_URL must use HTTPS (HTTP is allowed only on localhost outside production)",
    );
  }

  const secret = decodeSecret(rawSecret, "AUTOMATION_WEBHOOK_SECRET");
  const headerAuthSecret = decodeSecret(
    rawHeaderAuthSecret,
    "AUTOMATION_WEBHOOK_HEADER_AUTH_SECRET",
  );
  if (secret.equals(headerAuthSecret)) {
    throw new Error(
      "AUTOMATION_WEBHOOK_SECRET and AUTOMATION_WEBHOOK_HEADER_AUTH_SECRET must be independent secrets",
    );
  }

  const timeoutMs = boundedInteger(
    env,
    "AUTOMATION_WEBHOOK_TIMEOUT_MS",
    DEFAULTS.timeoutMs,
    1_000,
    30_000,
  );
  const lockTimeoutMs = boundedInteger(
    env,
    "AUTOMATION_OUTBOX_LOCK_TIMEOUT_MS",
    DEFAULTS.lockTimeoutMs,
    60_000,
    30 * 60_000,
  );
  if (lockTimeoutMs <= timeoutMs * 2) {
    throw new Error(
      "AUTOMATION_OUTBOX_LOCK_TIMEOUT_MS must exceed twice the webhook timeout",
    );
  }

  return {
    enabled: true,
    facilityAllowlist,
    requirePublicAddress: production,
    webhookUrl,
    secret,
    headerAuthSecret: rawHeaderAuthSecret,
    timeoutMs,
    lockTimeoutMs,
    maxAttempts: boundedInteger(
      env,
      "AUTOMATION_OUTBOX_MAX_ATTEMPTS",
      DEFAULTS.maxAttempts,
      1,
      20,
    ),
    batchSize: boundedInteger(
      env,
      "AUTOMATION_OUTBOX_BATCH_SIZE",
      DEFAULTS.batchSize,
      1,
      100,
    ),
    pollIntervalMs: boundedInteger(
      env,
      "AUTOMATION_OUTBOX_POLL_MS",
      DEFAULTS.pollIntervalMs,
      5_000,
      10 * 60_000,
    ),
    retentionDays: boundedInteger(
      env,
      "AUTOMATION_OUTBOX_RETENTION_DAYS",
      DEFAULTS.retentionDays,
      1,
      365,
    ),
    pendingMaxAgeDays: boundedInteger(
      env,
      "AUTOMATION_OUTBOX_PENDING_MAX_AGE_DAYS",
      DEFAULTS.pendingMaxAgeDays,
      1,
      90,
    ),
  };
}
