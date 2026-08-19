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
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
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
 * Domains used by seeded demo accounts and e2e test users. They must never
 * receive real mail: the addresses are fabricated, would bounce (or land in
 * a stranger's inbox — both domains are plausible real .sa domains), and
 * bounces damage the sender reputation of the shared Resend identity.
 */
const FIXTURE_EMAIL_DOMAINS = ["healthdocs.sa", "hospital.sa"];

export function isFixtureRecipient(email: string): boolean {
  const domain = email.toLowerCase().split("@").pop() ?? "";
  return FIXTURE_EMAIL_DOMAINS.includes(domain);
}

export function isEmailConfigured(): boolean {
  // Delivery is fail-closed: operators must explicitly opt in with `0` in
  // addition to supplying both secrets. Missing or malformed flags stay off.
  return Boolean(
    process.env.EMAIL_ALERTS_DISABLED === "0" &&
      process.env.RESEND_API_KEY?.trim() &&
      process.env.EMAIL_FROM?.trim(),
  );
}

export async function sendEmail(email: OutgoingEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!isEmailConfigured() || !apiKey || !from) {
    throw new EmailNotConfiguredError();
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return;
  if (res.status === 401 || res.status === 403) {
    throw new EmailNotConfiguredError(
      `Resend rejected the sender configuration (HTTP ${res.status})`,
    );
  }
  // Provider bodies can repeat recipient addresses or internal request detail;
  // keep persisted/logged failures limited to a status classification.
  throw new Error(`Resend delivery failed (HTTP ${res.status})`);
}
