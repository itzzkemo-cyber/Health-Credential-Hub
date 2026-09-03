import {
  automationOutboxTable,
  db,
} from "@workspace/db";
import {
  isAutomationOutboxEnabled,
  readAutomationFacilityAllowlist,
} from "./config";
import type { AutomationOutboxInsert } from "./events";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const automationOutboxEnabled = isAutomationOutboxEnabled();
const automationFacilityAllowlist = new Set(
  readAutomationFacilityAllowlist(process.env, automationOutboxEnabled),
);

/**
 * Persist an automation signal in the caller's business transaction.
 *
 * Event production is explicitly disabled by default. When enabled, a
 * failure to write the outbox row fails the surrounding transaction so n8n
 * can never observe a business action that the application did not commit.
 */
export async function enqueueAutomationEvent(
  tx: Transaction,
  event: AutomationOutboxInsert,
): Promise<void> {
  if (
    !automationOutboxEnabled ||
    !automationFacilityAllowlist.has(event.facilityId)
  )
    return;
  await tx
    .insert(automationOutboxTable)
    .values(event)
    .onConflictDoNothing();
}
