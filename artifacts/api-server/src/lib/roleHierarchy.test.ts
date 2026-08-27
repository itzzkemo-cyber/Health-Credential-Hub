import { describe, expect, it } from "vitest";
import type { User } from "@workspace/db";
import {
  canAccessCredentialOwner,
  canAssignRole,
  canManageTarget,
} from "./roleHierarchy";

function user(
  id: number,
  role: User["role"],
  facilityId = 10,
  overrides: Partial<User> = {},
): User {
  return {
    id,
    role,
    facilityId,
    isActive: true,
    departmentId: 2,
    supervisorId: null,
    ...overrides,
  } as User;
}

describe("role management hierarchy", () => {
  it("allows a hospital admin to manage only lower roles in the same facility", () => {
    const actor = user(1, "hospital_admin");

    expect(canManageTarget(actor, user(2, "department_manager"))).toBe(true);
    expect(canManageTarget(actor, user(3, "hospital_admin"))).toBe(false);
    expect(canManageTarget(actor, user(4, "system_admin"))).toBe(false);
    expect(canManageTarget(actor, user(5, "employee", 20))).toBe(false);
  });

  it("keeps the root administrator global without allowing another root", () => {
    const actor = user(1, "system_admin", 10);

    expect(canManageTarget(actor, user(2, "employee", 20))).toBe(true);
    expect(canAssignRole(actor, "hospital_admin")).toBe(true);
    expect(canManageTarget(actor, user(3, "system_admin", 20))).toBe(false);
    expect(canAssignRole(actor, "system_admin")).toBe(false);
  });

  it("preserves self-owned credential access but rejects scoped peers and higher roles", () => {
    const supervisor = user(10, "supervisor");
    const directReport = user(11, "employee", 10, { supervisorId: 10 });
    const peer = user(12, "supervisor", 10, { supervisorId: 10 });
    const higher = user(13, "department_manager", 10, { supervisorId: 10 });

    expect(canAccessCredentialOwner(supervisor, supervisor)).toBe(true);
    expect(canAccessCredentialOwner(supervisor, directReport)).toBe(true);
    expect(canAccessCredentialOwner(supervisor, peer)).toBe(false);
    expect(canAccessCredentialOwner(supervisor, higher)).toBe(false);
  });
});
