/**
 * Email provider adapter — Resend via the Replit-managed connector.
 *
 * `connectors.proxy()` injects the managed API credential server-side; this
 * process never handles a token, so there is nothing to configure locally
 * and `isEmailConfigured()` is statically true. If the connector is later
 * detached or revoked, the proxy answers 401/403 and `sendEmail` surfaces
 * that as `EmailNotConfiguredError`.
 *
 * CONTRACT (relied on by dispatch.ts and the forgot-password route):
 * - `EmailNotConfiguredError` = configuration/authorization-class failure
 *   (revoked connector, restricted key, unverified sender domain). Dispatch
 *   releases the ledger claim for those, so alerts stay pending and send
 *   normally once the configuration is fixed.
 * - Any other error = genuine delivery failure (invalid recipient, provider
 *   rejection). Those consume the one allowed attempt and are recorded as
 *   `failed` with the error message.
 */
import { ReplitConnectors } from "@replit/connectors-sdk";

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
 * Sender identity. Resend's shared onboarding sender works with the managed
 * connector out of the box; set EMAIL_FROM to switch to a custom verified
 * domain later (e.g. "وثائقي الصحي <no-reply@company.sa>").
 */
const FROM = process.env["EMAIL_FROM"] ?? "HealthDocs <onboarding@resend.dev>";

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

const connectors = new ReplitConnectors();

export function isEmailConfigured(): boolean {
  // The Resend connector is attached; credentials are injected by the proxy.
  return true;
}

export async function sendEmail(email: OutgoingEmail): Promise<void> {
  const res = await connectors.proxy("resend", "/emails", {
    method: "POST",
    body: {
      from: FROM,
      to: [email.to],
      subject: email.subject,
      html: email.html,
    },
  });
  if (res.ok) return;
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 401 || res.status === 403) {
    throw new EmailNotConfiguredError(
      `Resend rejected the sender configuration (HTTP ${res.status}): ${detail}`,
    );
  }
  throw new Error(`Resend delivery failed (HTTP ${res.status}): ${detail}`);
}
