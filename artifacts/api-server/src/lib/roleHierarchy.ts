import type { User } from "@workspace/db";

export const ROLE_RANK: Readonly<Record<User["role"], number>> = {
  employee: 0,
  supervisor: 1,
  department_manager: 2,
  hospital_admin: 3,
  system_admin: 4,
};

/**
 * Privileged role assignment is reserved for admins below their own rank.
 * The bootstrap command is the only supported way to create the single root
 * system administrator; authenticated account-management APIs cannot mint a
 * second root account.
 */
export function canAssignRole(actor: User, newRole: User["role"]): boolean {
  if (actor.role === "system_admin") return newRole !== "system_admin";
  if (actor.role !== "hospital_admin") return false;
  return ROLE_RANK[newRole] < ROLE_RANK[actor.role];
}

/**
 * Strict management hierarchy. Only system administrators are global; every
 * other actor must stay in-facility and may manage only a lower-ranked target.
 * Callers handle explicitly allowed self-service separately.
 */
export function canManageTarget(actor: User, target: User): boolean {
  if (actor.role === "system_admin") return target.role !== "system_admin";
  return (
    actor.facilityId === target.facilityId &&
    ROLE_RANK[target.role] < ROLE_RANK[actor.role]
  );
}

/** Team/facility visibility used before applying operation-specific policy. */
export function isUserInScope(current: User, target: User): boolean {
  if (!current.isActive) return false;
  if (current.id === target.id || current.role === "system_admin") return true;
  if (current.role === "hospital_admin") {
    return current.facilityId === target.facilityId;
  }
  if (current.role === "department_manager") {
    return (
      current.facilityId === target.facilityId &&
      current.departmentId != null &&
      current.departmentId === target.departmentId
    );
  }
  return (
    current.role === "supervisor" &&
    current.facilityId === target.facilityId &&
    target.supervisorId === current.id
  );
}

/**
 * Credential evidence permits self-service. Delegated access additionally
 * requires the target to be both team/facility-scoped and lower-ranked.
 */
export function canAccessCredentialOwner(current: User, target: User): boolean {
  if (!isUserInScope(current, target)) return false;
  return current.id === target.id || canManageTarget(current, target);
}
