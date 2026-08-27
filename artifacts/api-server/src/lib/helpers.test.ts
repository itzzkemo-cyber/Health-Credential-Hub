import { describe, expect, it, vi } from "vitest";
import type { CredentialPolicyRow, CredentialRow, User } from "@workspace/db";

// The helpers under test are pure, but their module also exports database
// helpers. Stub those imports so this unit suite never requires a real DB.
vi.mock("@workspace/db", () => ({
  db: {},
  usersTable: {},
  credentialsTable: {},
  credentialPoliciesTable: {},
  auditLogsTable: {},
  notificationsTable: {},
  departmentsTable: {},
}));

import {
  computeEmployeeStats,
  evaluateCredentialVerificationChange,
  hasMaterialCredentialChange,
  missingTypesFor,
} from "./helpers";
import { isUserInScope } from "./roleHierarchy";

const employee = {
  id: 7,
  facilityId: 2,
  departmentId: 4,
  role: "employee",
} as User;

function credential(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: 11,
    employeeId: employee.id,
    type: "BLS",
    customTypeName: null,
    customTypeNameAr: null,
    holderName: "Test Employee",
    holderNameAr: "موظف تجريبي",
    issuerName: "Test Issuer",
    issuerNameAr: "جهة تجريبية",
    certificateNumber: "CERT-1",
    issueDate: "2025-01-01",
    expiryDate: "2999-01-01",
    fileUrl: "/objects/uploads/document.pdf",
    fileType: "application/pdf",
    qrToken: "qr-token",
    tags: [],
    notes: null,
    confidence: null,
    isVerified: true,
    rowVersion: 1,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

function policy(
  credentialType: string,
  overrides: Partial<CredentialPolicyRow> = {},
): CredentialPolicyRow {
  return {
    id: credentialType === "BLS" ? 1 : 2,
    facilityId: employee.facilityId,
    credentialType,
    departmentId: null,
    roles: [],
    isRequired: true,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("credential policy compliance", () => {
  it("does not satisfy a requirement with an unverified credential", () => {
    const creds = [credential({ isVerified: false })];
    const policies = [policy("BLS")];

    expect(missingTypesFor(employee, creds, policies)).toEqual(["BLS"]);
    expect(computeEmployeeStats(employee, creds, policies).complianceRate).toBe(
      0,
    );
  });

  it("does not satisfy a requirement with an expired verified credential", () => {
    const creds = [credential({ expiryDate: "2000-01-01" })];
    const policies = [policy("BLS")];

    expect(missingTypesFor(employee, creds, policies)).toEqual(["BLS"]);
    expect(computeEmployeeStats(employee, creds, policies).complianceRate).toBe(
      0,
    );
  });

  it("does not count a soft-deleted credential or satisfy compliance with it", () => {
    const creds = [
      credential({
        deletedAt: new Date("2026-08-19T08:00:00Z"),
        deletedBy: 12,
      }),
    ];
    const policies = [policy("BLS")];

    expect(missingTypesFor(employee, creds, policies)).toEqual(["BLS"]);
    expect(computeEmployeeStats(employee, creds, policies)).toMatchObject({
      totalCredentials: 0,
      expiredCount: 0,
      expiringCount: 0,
      missingCount: 1,
      complianceRate: 0,
    });
  });

  it("bases the rate only on distinct applicable required types", () => {
    const creds = [credential()];
    const policies = [
      policy("BLS"),
      policy("BLS", { id: 3 }),
      policy("ACLS"),
      policy("PALS", { facilityId: 99 }),
      policy("NRP", { isRequired: false }),
    ];

    const stats = computeEmployeeStats(employee, creds, policies);
    expect(stats.missingTypes).toEqual(["ACLS"]);
    expect(stats.complianceRate).toBe(50);
  });

  it("reports full compliance when no policy applies", () => {
    const policies = [policy("BLS", { departmentId: 99 })];

    expect(computeEmployeeStats(employee, [], policies).complianceRate).toBe(
      100,
    );
  });
});

describe("server-side employee scope", () => {
  const scopeUser = (overrides: Partial<User>): User =>
    ({
      id: 1,
      role: "employee",
      facilityId: 10,
      departmentId: 20,
      supervisorId: null,
      isActive: true,
      ...overrides,
    }) as User;
  const target = scopeUser({ id: 9, supervisorId: 2 });

  it("keeps employees to themselves and supervisors to direct reports", () => {
    expect(isUserInScope(scopeUser({ id: 9 }), target)).toBe(true);
    expect(isUserInScope(scopeUser({ id: 8 }), target)).toBe(false);
    expect(
      isUserInScope(scopeUser({ id: 2, role: "supervisor" }), target),
    ).toBe(true);
    expect(
      isUserInScope(scopeUser({ id: 3, role: "supervisor" }), target),
    ).toBe(false);
    expect(
      isUserInScope(
        scopeUser({ id: 2, role: "supervisor", facilityId: 99 }),
        target,
      ),
    ).toBe(false);
  });

  it("requires department and hospital managers to stay in facility scope", () => {
    expect(
      isUserInScope(scopeUser({ id: 3, role: "department_manager" }), target),
    ).toBe(true);
    expect(
      isUserInScope(
        scopeUser({
          id: 3,
          role: "department_manager",
          facilityId: 99,
        }),
        target,
      ),
    ).toBe(false);
    expect(
      isUserInScope(scopeUser({ id: 4, role: "hospital_admin" }), target),
    ).toBe(true);
    expect(
      isUserInScope(
        scopeUser({ id: 4, role: "hospital_admin", facilityId: 99 }),
        target,
      ),
    ).toBe(false);
  });

  it("allows active system administrators and rejects inactive actors", () => {
    expect(
      isUserInScope(
        scopeUser({ id: 5, role: "system_admin", facilityId: 99 }),
        target,
      ),
    ).toBe(true);
    expect(
      isUserInScope(
        scopeUser({ id: 5, role: "system_admin", isActive: false }),
        target,
      ),
    ).toBe(false);
  });
});

describe("material credential changes", () => {
  const current = credential();

  it("treats re-sending the current file path as unchanged", () => {
    expect(
      hasMaterialCredentialChange(current, { fileUrl: current.fileUrl }),
    ).toBe(false);
  });

  it.each([
    {
      patch: { fileUrl: "/objects/uploads/replacement.pdf" },
      kind: "replacement",
    },
    { patch: { fileUrl: null }, kind: "removal" },
    { patch: { expiryDate: "2999-02-01" }, kind: "factual edit" },
    { patch: { fileType: "image/png" }, kind: "file metadata edit" },
  ])("detects a material $kind", ({ patch }) => {
    expect(hasMaterialCredentialChange(current, patch)).toBe(true);
  });

  it("does not invalidate verification for internal notes and tags", () => {
    expect(
      hasMaterialCredentialChange(current, {
        notes: "Internal follow-up",
        tags: ["reviewed"],
      }),
    ).toBe(false);
  });

  it("drops verification after a material edit", () => {
    const decision = evaluateCredentialVerificationChange(
      current,
      { certificateNumber: "CERT-2" },
      undefined,
    );

    expect(decision.nextVerification).toBe(false);
    expect(decision.conflictsWithVerification).toBe(false);
  });

  it("rejects verifying while applying a material edit", () => {
    const decision = evaluateCredentialVerificationChange(
      current,
      { fileUrl: "/objects/uploads/replacement.pdf" },
      true,
    );

    expect(decision.conflictsWithVerification).toBe(true);
    expect(decision.nextVerification).toBe(false);
  });

  it("allows a standalone verification decision", () => {
    const decision = evaluateCredentialVerificationChange(current, {}, true);

    expect(decision.materialChange).toBe(false);
    expect(decision.conflictsWithVerification).toBe(false);
    expect(decision.nextVerification).toBe(true);
  });
});
