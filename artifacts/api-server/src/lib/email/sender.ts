/**
 * Email provider adapter — Resend's HTTPS API.
 *
 * RESEND_API_KEY is injected at runtime from the hosting secret manager and
 * is never exposed to the browser or written to application logs.
 *
 * CONTRACT (relied on by dispatch.ts and the forgot-password route):
 * - `EmailNotConfiguredError` = configuration/authorization-class failure
 *   (revoked key, restricted key, unverified sender domain). Dispatch
 *   releases the ledger claim for those, so alerts stay pending and send
 *   normally once the configuration is fixed.
 * - Any other error = genuine delivery failure (invalid recipient, provider
 *   rejection). Those consume the one allowed attempt and are recorded as
 *   `failed` with the error message.
 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getPublicAppUrl } from "../publicUrl";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  /** Stable across retries; deliberately contains no recipient or reset token. */
  idempotencyKey: string;
}

export class EmailNotConfiguredError extends Error {
  constructor(message = "No email provider is configured") {
    super(message);
    this.name = "EmailNotConfiguredError";
  }
}

/**
 * Sender identity must use a domain verified in the user's Resend account.
 */
/**
 * RFC-reserved `.invalid` addresses used by automated tests must never reach
 * the provider. Real domains are never suppressed merely because their name
 * resembles old fixture data.
 */
export function isFixtureRecipient(email: string): boolean {
  const domain = email.toLowerCase().split("@").pop() ?? "";
  return domain === "invalid" || domain.endsWith(".invalid");
}

export type EmailDeliveryReadiness =
  "disabled" | "configured" | "misconfigured";

interface EmailConfiguration {
  readiness: EmailDeliveryReadiness;
  apiKey?: string;
  from?: string;
}

const RESEND_API_KEY = /^re_[A-Za-z0-9_-]{16,}$/;
const EMAIL_ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function senderAddress(from: string): string | null {
  if (/[\r\n]/.test(from) || from.length > 320) return null;
  const angle = from.match(/^[^<>]{1,160}<([^<>]+)>$/u);
  if (angle) return angle[1]?.trim() ?? null;
  if (from.includes("<") || from.includes(">")) return null;
  return from;
}

/**
 * Validate the complete opt-in atomically. Disabled delivery stays optional,
 * while an attempted-but-invalid opt-in is visible to readiness checks and can
 * never result in a provider call.
 */
export function getEmailDeliveryReadiness(
  env: NodeJS.ProcessEnv = process.env,
): EmailDeliveryReadiness {
  return readEmailConfiguration(env).readiness;
}

function readEmailConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): EmailConfiguration {
  const enabledFlag = env.EMAIL_ALERTS_DISABLED;
  if (enabledFlag == null || enabledFlag === "1") {
    return { readiness: "disabled" };
  }
  if (enabledFlag !== "0") return { readiness: "misconfigured" };

  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  const from = env.EMAIL_FROM?.trim() ?? "";
  const address = senderAddress(from);
  let publicAppUrl: string | null = null;
  try {
    publicAppUrl = getPublicAppUrl(env);
  } catch {
    return { readiness: "misconfigured" };
  }
  if (
    !RESEND_API_KEY.test(apiKey) ||
    !address ||
    !EMAIL_ADDRESS.test(address) ||
    !publicAppUrl
  ) {
    return { readiness: "misconfigured" };
  }
  return { readiness: "configured", apiKey, from };
}

export function isEmailConfigured(): boolean {
  return getEmailDeliveryReadiness() === "configured";
}

/**
 * Hash internal uniqueness material before it crosses the provider boundary.
 * The returned value is safe to reuse for Resend's Idempotency-Key header but
 * must still not be written to logs.
 */
export function createEmailIdempotencyKey(
  purpose: string,
  uniqueValue: string,
): string {
  const digest = createHash("sha256")
    .update(`${purpose}\0${uniqueValue}`)
    .digest("hex");
  return `healthdocs-${digest}`;
}

export async function sendEmail(email: OutgoingEmail): Promise<void> {
  const config = readEmailConfiguration();
  if (config.readiness !== "configured" || !config.apiKey || !config.from) {
    throw new EmailNotConfiguredError();
  }
  if (!/^healthdocs-[a-f0-9]{64}$/.test(email.idempotencyKey)) {
    throw new EmailNotConfiguredError("Invalid email idempotency key");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body: JSON.stringify({
          from: config.from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === 0) {
        await delay(250);
        continue;
      }
      throw error;
    }
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) {
      throw new EmailNotConfiguredError(
        `Resend rejected the sender configuration (HTTP ${res.status})`,
      );
    }
    const transient =
      res.status === 429 || [500, 502, 503, 504].includes(res.status);
    if (transient && attempt === 0) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = Number(retryAfterHeader);
      const retryDelayMs =
        retryAfterHeader != null && Number.isFinite(retryAfter)
          ? Math.min(Math.max(retryAfter * 1000, 0), 2_000)
          : 250;
      await delay(retryDelayMs);
      continue;
    }
    // Provider bodies can repeat recipient addresses or internal request
    // detail; keep persisted/logged failures limited to a status class.
    throw new Error(`Resend delivery failed (HTTP ${res.status})`);
  }
}
