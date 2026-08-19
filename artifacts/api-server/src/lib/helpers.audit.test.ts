import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    insert: dbMocks.insert,
  },
  usersTable: {},
  credentialsTable: {},
  credentialPoliciesTable: {},
  auditLogsTable: { name: "audit_logs" },
  notificationsTable: {},
  departmentsTable: {},
}));

import { logAudit } from "./helpers";

describe("audit event facility scope", () => {
  beforeEach(() => {
    dbMocks.insert.mockReset();
    dbMocks.values.mockReset();
    dbMocks.values.mockResolvedValue(undefined);
    dbMocks.insert.mockReturnValue({ values: dbMocks.values });
  });

  it("records the affected facility without changing the actor identity", async () => {
    const actor = {
      id: 7,
      facilityId: 10,
      name: "Cross-facility Admin",
      nameAr: "مسؤول متعدد المنشآت",
    };

    await logAudit(
      actor as never,
      "Updated employee",
      "تحديث موظف",
      "Employee #42",
      "الموظف #42",
      undefined,
      "127.0.0.1",
      20,
    );

    expect(dbMocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: actor.id,
        facilityId: 20,
        userName: actor.name,
        userNameAr: actor.nameAr,
        action: "Updated employee",
      }),
    );
  });

  it("defaults to the actor facility for same-facility events", async () => {
    const actor = {
      id: 8,
      facilityId: 30,
      name: "Facility Admin",
      nameAr: "مسؤول المنشأة",
    };

    await logAudit(
      actor as never,
      "Signed in",
      "تسجيل دخول",
      "Session",
      "الجلسة",
    );

    expect(dbMocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ facilityId: 30, userId: actor.id }),
    );
  });
});
