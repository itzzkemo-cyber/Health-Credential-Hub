import type {
  AutomationEventData,
  AutomationEventType,
  CredentialRow,
} from "@workspace/db/schema";

export interface AutomationOutboxInsert {
  facilityId: number;
  credentialId: number;
  eventType: AutomationEventType;
  deduplicationKey: string;
  payload: AutomationEventData;
}

function baseCredentialData(credential: CredentialRow) {
  return {
    credentialId: credential.id,
    employeeId: credential.employeeId,
    credentialType: credential.type,
  };
}

export function credentialCreatedEvent(
  credential: CredentialRow,
  facilityId: number,
): AutomationOutboxInsert {
  return {
    facilityId,
    credentialId: credential.id,
    eventType: "credential.created",
    deduplicationKey: `credential.created:${credential.id}`,
    payload: baseCredentialData(credential),
  };
}

export function credentialVerificationChangedEvent(
  credential: CredentialRow,
  facilityId: number,
): AutomationOutboxInsert {
  return {
    facilityId,
    credentialId: credential.id,
    eventType: "credential.verification_changed",
    deduplicationKey: `credential.verification_changed:${credential.id}:v${credential.rowVersion}`,
    payload: {
      ...baseCredentialData(credential),
      isVerified: credential.isVerified,
    },
  };
}

export function credentialExpiryDueEvent(
  credential: CredentialRow,
  facilityId: number,
  dueInDays: number,
  thresholdDays: number,
): AutomationOutboxInsert {
  return {
    facilityId,
    credentialId: credential.id,
    eventType: "credential.expiry_due",
    deduplicationKey: `credential.expiry_due:${credential.id}:${credential.expiryDate}:${thresholdDays}`,
    payload: {
      ...baseCredentialData(credential),
      expiryDate: credential.expiryDate,
      dueInDays,
      thresholdDays,
    },
  };
}

const EXPIRY_THRESHOLDS = [90, 60, 30, 15, 7, 1, 0] as const;

/** Closest crossed threshold, allowing a delayed worker to catch up once. */
export function expiryThresholdFor(dueInDays: number): number | null {
  if (!Number.isSafeInteger(dueInDays)) return null;
  if (dueInDays < 0) return 0;
  for (let i = EXPIRY_THRESHOLDS.length - 1; i >= 0; i -= 1) {
    const threshold = EXPIRY_THRESHOLDS[i];
    if (threshold != null && dueInDays <= threshold) return threshold;
  }
  return null;
}

export function retryBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(30_000 * 2 ** exponent, 60 * 60_000);
}
