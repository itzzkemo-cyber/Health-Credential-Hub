import {
  db,
  usersTable,
  credentialsTable,
  credentialPoliciesTable,
  auditLogsTable,
  notificationsTable,
  departmentsTable,
  type User,
  type CredentialRow,
  type CredentialPolicyRow,
  type Department,
} from "@workspace/db";
import { eq, inArray, and, isNull } from "drizzle-orm";
import { canAccessCredentialOwner } from "./roleHierarchy";

// ---------------------------------------------------------------------------
// Dates & status
// ---------------------------------------------------------------------------

export const EXPIRING_WINDOW_DAYS = 90;

export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dateStr(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function daysUntil(dateString: string): number {
  const target = new Date(`${dateString}T00:00:00Z`).getTime();
  const now = new Date(`${todayStr()}T00:00:00Z`).getTime();
  return Math.round((target - now) / 86_400_000);
}

export type CredStatus = "active" | "expiring_soon" | "expired";

export function computeStatus(expiryDate: string): CredStatus {
  const d = daysUntil(expiryDate);
  if (d < 0) return "expired";
  if (d <= EXPIRING_WINDOW_DAYS) return "expiring_soon";
  return "active";
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    nameAr: u.nameAr,
    role: u.role,
    departmentId: u.departmentId,
    supervisorId: u.supervisorId,
    facilityId: u.facilityId,
    jobTitle: u.jobTitle,
    jobTitleAr: u.jobTitleAr,
    employeeNumber: u.employeeNumber,
    phone: u.phone,
    avatarUrl: u.avatarUrl,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    totpEnabled: u.totpEnabled,
    createdAt: u.createdAt.toISOString(),
  };
}

export function employeeSummary(u: User) {
  return {
    id: u.id,
    name: u.name,
    nameAr: u.nameAr,
    jobTitle: u.jobTitle,
    jobTitleAr: u.jobTitleAr,
    avatarUrl: u.avatarUrl,
  };
}

export function serializeCredential(c: CredentialRow, employee?: User | null) {
  return {
    id: c.id,
    employeeId: c.employeeId,
    ...(employee ? { employee: employeeSummary(employee) } : {}),
    type: c.type,
    customTypeName: c.customTypeName,
    customTypeNameAr: c.customTypeNameAr,
    holderName: c.holderName,
    holderNameAr: c.holderNameAr,
    issuerName: c.issuerName,
    issuerNameAr: c.issuerNameAr,
    certificateNumber: c.certificateNumber,
    issueDate: c.issueDate,
    expiryDate: c.expiryDate,
    status: computeStatus(c.expiryDate),
    fileUrl: c.fileUrl,
    fileType: c.fileType,
    qrToken: c.qrToken,
    tags: c.tags ?? [],
    notes: c.notes,
    verificationUrl: `/verify/${c.qrToken}`,
    confidence: c.confidence,
    isVerified: c.isVerified,
    version: c.rowVersion,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

export async function getScopedUsers(
  current: User,
  executor: Pick<typeof db, "select"> = db,
  selectedUserIds?: number[],
): Promise<User[]> {
  if (selectedUserIds?.length === 0) return [];
  if (current.role === "system_admin" && selectedUserIds === undefined) {
    return executor.select().from(usersTable);
  }
  const facilityScope = eq(usersTable.facilityId, current.facilityId);
  const selectedScope = selectedUserIds
    ? inArray(usersTable.id, selectedUserIds)
    : undefined;
  const all = await executor
    .select()
    .from(usersTable)
    .where(
      selectedScope
        ? current.role === "system_admin"
          ? selectedScope
          : and(facilityScope, selectedScope)
        : facilityScope,
    );

  switch (current.role) {
    case "employee":
      return all.filter((u) => u.id === current.id);
    case "supervisor":
      return all.filter(
        (u) => u.id === current.id || u.supervisorId === current.id,
      );
    case "department_manager":
      return all.filter(
        (u) =>
          u.id === current.id ||
          (u.departmentId != null && u.departmentId === current.departmentId),
      );
    default:
      return all;
  }
}

export async function getCredentialScopedUsers(current: User): Promise<User[]> {
  const scoped = await getScopedUsers(current);
  return scoped.filter((target) => canAccessCredentialOwner(current, target));
}

export async function getCredentialsFor(
  userIds: number[],
): Promise<CredentialRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select()
    .from(credentialsTable)
    .where(
      and(
        inArray(credentialsTable.employeeId, userIds),
        isNull(credentialsTable.deletedAt),
      ),
    );
}

// ---------------------------------------------------------------------------
// Policies / missing credentials / stats
// ---------------------------------------------------------------------------

export function policyAppliesTo(p: CredentialPolicyRow, u: User): boolean {
  if (!p.isRequired) return false;
  if (p.facilityId !== u.facilityId) return false;
  const roles = p.roles ?? [];
  if (roles.length > 0 && !roles.includes(u.role)) return false;
  if (p.departmentId != null && p.departmentId !== u.departmentId) return false;
  return true;
}

export function missingTypesFor(
  u: User,
  creds: CredentialRow[],
  policies: CredentialPolicyRow[],
): string[] {
  const owned = new Set(
    creds
      .filter(
        (c) =>
          c.employeeId === u.id &&
          c.deletedAt == null &&
          c.isVerified &&
          computeStatus(c.expiryDate) !== "expired",
      )
      .map((c) => c.type as string),
  );
  const required = new Set<string>();
  for (const p of policies) {
    if (policyAppliesTo(p, u)) required.add(p.credentialType);
  }
  return [...required].filter((t) => !owned.has(t));
}

export interface EmployeeStats {
  complianceRate: number;
  totalCredentials: number;
  expiredCount: number;
  expiringCount: number;
  missingCount: number;
  isAtRisk: boolean;
  missingTypes: string[];
}

export function computeEmployeeStats(
  u: User,
  allCreds: CredentialRow[],
  policies: CredentialPolicyRow[],
): EmployeeStats {
  const creds = allCreds.filter(
    (c) => c.employeeId === u.id && c.deletedAt == null,
  );
  const expiredCount = creds.filter(
    (c) => computeStatus(c.expiryDate) === "expired",
  ).length;
  const expiringCount = creds.filter(
    (c) => computeStatus(c.expiryDate) === "expiring_soon",
  ).length;
  const missingTypes = missingTypesFor(u, creds, policies);
  const missingCount = missingTypes.length;
  const requiredTypes = new Set(
    policies.filter((p) => policyAppliesTo(p, u)).map((p) => p.credentialType),
  );
  const satisfiedRequirements = requiredTypes.size - missingCount;
  const complianceRate =
    requiredTypes.size === 0
      ? 100
      : Math.round((satisfiedRequirements / requiredTypes.size) * 100);
  return {
    complianceRate,
    totalCredentials: creds.length,
    expiredCount,
    expiringCount,
    missingCount,
    isAtRisk: expiredCount > 0 || missingCount > 0,
    missingTypes,
  };
}

/**
 * Fields whose contents are evidence used to verify a credential. Changing
 * any of them invalidates an earlier verification decision. Notes and tags
 * are deliberately excluded because they are internal organization metadata.
 */
const MATERIAL_CREDENTIAL_FIELDS = [
  "type",
  "customTypeName",
  "customTypeNameAr",
  "holderName",
  "holderNameAr",
  "issuerName",
  "issuerNameAr",
  "certificateNumber",
  "issueDate",
  "expiryDate",
  "fileUrl",
  "fileType",
] as const;

export function hasMaterialCredentialChange(
  current: CredentialRow,
  patch: Record<string, unknown>,
): boolean {
  return MATERIAL_CREDENTIAL_FIELDS.some(
    (field) =>
      Object.prototype.hasOwnProperty.call(patch, field) &&
      patch[field] !== current[field],
  );
}

export function evaluateCredentialVerificationChange(
  current: CredentialRow,
  patch: Record<string, unknown>,
  requestedVerification: boolean | undefined,
): {
  materialChange: boolean;
  conflictsWithVerification: boolean;
  nextVerification: boolean | undefined;
} {
  const materialChange = hasMaterialCredentialChange(current, patch);
  return {
    materialChange,
    conflictsWithVerification: materialChange && requestedVerification === true,
    nextVerification: materialChange ? false : requestedVerification,
  };
}

export async function getPolicies(
  facilityId: number | null,
): Promise<CredentialPolicyRow[]> {
  if (facilityId == null)
    return db
      .select()
      .from(credentialPoliciesTable)
      .where(isNull(credentialPoliciesTable.deletedAt));
  return db
    .select()
    .from(credentialPoliciesTable)
    .where(
      and(
        eq(credentialPoliciesTable.facilityId, facilityId),
        isNull(credentialPoliciesTable.deletedAt),
      ),
    );
}

export async function getDepartments(
  facilityId: number | null,
): Promise<Department[]> {
  if (facilityId == null)
    return db
      .select()
      .from(departmentsTable)
      .where(isNull(departmentsTable.deletedAt));
  return db
    .select()
    .from(departmentsTable)
    .where(
      and(
        eq(departmentsTable.facilityId, facilityId),
        isNull(departmentsTable.deletedAt),
      ),
    );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function logAudit(
  user: User,
  action: string,
  actionAr: string,
  target: string,
  targetAr: string,
  details?: string,
  ipAddress?: string,
  facilityId: number = user.facilityId,
): Promise<void> {
  await db.insert(auditLogsTable).values({
    userId: user.id,
    facilityId,
    userName: user.name,
    userNameAr: user.nameAr,
    action,
    actionAr,
    target,
    targetAr,
    details: details ?? null,
    ipAddress: ipAddress ?? null,
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const THRESHOLDS = [90, 60, 30, 15, 7, 1];

export async function syncExpiryNotifications(user: User): Promise<void> {
  const creds = await db
    .select()
    .from(credentialsTable)
    .where(
      and(
        eq(credentialsTable.employeeId, user.id),
        isNull(credentialsTable.deletedAt),
      ),
    );

  if (creds.length === 0) return;

  const existing = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, user.id),
        inArray(
          notificationsTable.credentialId,
          creds.map((c) => c.id),
        ),
      ),
    );

  const typeLabel = (c: CredentialRow) => c.customTypeName ?? c.type;
  const typeLabelAr = (c: CredentialRow) => c.customTypeNameAr ?? c.type;

  for (const c of creds) {
    const d = daysUntil(c.expiryDate);
    if (d < 0) {
      const has = existing.some(
        (n) => n.credentialId === c.id && n.type === "expired",
      );
      if (!has) {
        await db.insert(notificationsTable).values({
          userId: user.id,
          type: "expired",
          titleAr: "وثيقة منتهية الصلاحية",
          titleEn: "Credential expired",
          messageAr: `انتهت صلاحية «${typeLabelAr(c)}» بتاريخ ${c.expiryDate}`,
          messageEn: `Your ${typeLabel(c)} expired on ${c.expiryDate}`,
          credentialId: c.id,
          employeeId: user.id,
          isRead: false,
          daysUntilExpiry: d,
        });
      }
    } else {
      const enabledThresholds = THRESHOLDS.filter((threshold) =>
        user.notificationPrefs.includes(threshold),
      );
      const crossed = enabledThresholds.filter((t) => d <= t);
      if (crossed.length === 0) continue;
      const threshold = Math.min(...crossed);
      const has = existing.some(
        (n) =>
          n.credentialId === c.id &&
          n.type === "expiry_warning" &&
          n.daysUntilExpiry === threshold,
      );
      if (!has) {
        await db.insert(notificationsTable).values({
          userId: user.id,
          type: "expiry_warning",
          titleAr: "تنبيه انتهاء صلاحية",
          titleEn: "Expiry warning",
          messageAr: `تنتهي صلاحية «${typeLabelAr(c)}» خلال ${threshold} يوم`,
          messageEn: `Your ${typeLabel(c)} expires within ${threshold} days`,
          credentialId: c.id,
          employeeId: user.id,
          isRead: false,
          daysUntilExpiry: threshold,
        });
      }
    }
  }
}
