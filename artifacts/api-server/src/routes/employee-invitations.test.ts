import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  emailConfigured: true,
  actor: {
    id: 1,
    role: "hospital_admin",
    facilityId: 10,
    isActive: true,
    sessionVersion: 4,
    passwordHash: "admin-hash",
    totpEnabled: true,
    totpSecret: "encrypted-secret",
    name: "Facility Admin",
    nameAr: "مدير المنشأة",
  } as Record<string, unknown>,
  lockedActor: {} as Record<string, unknown>,
  extraUsers: [] as Array<Record<string, unknown>>,
  departmentRows: [] as Array<Record<string, unknown>>,
  facilityRows: [{ id: 10 }] as Array<Record<string, unknown>>,
  existingEmailRows: [] as Array<Record<string, unknown>>,
  invitationValues: null as Record<string, unknown> | null,
  invitationAudit: null as Record<string, unknown> | null,
  providerFailureAudit: null as Record<string, unknown> | null,
  revokeAudit: null as Record<string, unknown> | null,
  priorRevocation: null as Record<string, unknown> | null,
  providerFailureRevocation: false,
  providerFailureAuditFails: false,
  providerFailureFallbackRevocation: false,
  invitationListRows: [] as Array<Record<string, unknown>>,
  invitationListSelection: null as Record<string, unknown> | null,
  invitationListWhere: null as unknown,
  lockedInvitation: null as Record<string, unknown> | null,
  transactionCount: 0,
  comparePassword: vi.fn(
    async (password: string) => password === " admin password ",
  ),
  consumeSecondFactor: vi.fn(async (_tx: unknown, actor: unknown) => actor),
  sendEmail: vi.fn(async (_email: { html: string }) => undefined),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  desc: vi.fn((column: unknown) => ({ column, direction: "desc" })),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  gt: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ column, values })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
  sql: vi.fn(() => ({ kind: "sql" })),
}));

vi.mock("@workspace/db", () => {
  const usersTable = {
    id: "users.id",
    email: "users.email",
    facilityId: "users.facilityId",
  };
  const departmentsTable = {
    id: "departments.id",
    facilityId: "departments.facilityId",
    deletedAt: "departments.deletedAt",
  };
  const facilitiesTable = { id: "facilities.id" };
  const employeeInvitationsTable = {
    kind: "employeeInvitations",
    id: "employeeInvitations.id",
    email: "employeeInvitations.email",
    facilityId: "employeeInvitations.facilityId",
    departmentId: "employeeInvitations.departmentId",
    supervisorId: "employeeInvitations.supervisorId",
    name: "employeeInvitations.name",
    nameAr: "employeeInvitations.nameAr",
    jobTitle: "employeeInvitations.jobTitle",
    jobTitleAr: "employeeInvitations.jobTitleAr",
    employeeNumber: "employeeInvitations.employeeNumber",
    phone: "employeeInvitations.phone",
    acceptedAt: "employeeInvitations.acceptedAt",
    revokedAt: "employeeInvitations.revokedAt",
    expiresAt: "employeeInvitations.expiresAt",
    createdAt: "employeeInvitations.createdAt",
  };
  const auditLogsTable = { kind: "auditLogs" };
  const projectSelection = (
    row: Record<string, unknown>,
    selection: Record<string, unknown> | undefined,
  ) =>
    selection == null
      ? row
      : Object.fromEntries(
          Object.entries(selection).map(([key, column]) => [
            key,
            row[
              typeof column === "string" && column.includes(".")
                ? column.split(".").at(-1)!
                : key
            ],
          ]),
        );
  return {
    usersTable,
    departmentsTable,
    facilitiesTable,
    employeeInvitationsTable,
    auditLogsTable,
    credentialsTable: {},
    USER_ROLES: [
      "employee",
      "supervisor",
      "department_manager",
      "hospital_admin",
      "system_admin",
    ],
    db: {
      select: vi.fn((selection?: Record<string, unknown>) => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn((condition: unknown) => {
            if (table !== employeeInvitationsTable) {
              return Promise.resolve([]);
            }
            state.invitationListSelection = selection ?? null;
            state.invitationListWhere = condition;
            return {
              orderBy: () => ({
                limit: async () =>
                  state.invitationListRows.map((row) =>
                    projectSelection(row, selection),
                  ),
              }),
            };
          }),
        })),
      })),
      update: vi.fn((table: unknown) => ({
        set: () => ({
          where: async () => {
            if (table !== employeeInvitationsTable) {
              throw new Error("Unexpected update table");
            }
            state.providerFailureFallbackRevocation = true;
          },
        }),
      })),
      transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
        state.transactionCount += 1;
        const tx = {
          execute: vi.fn(async () => undefined),
          select: (_selection?: unknown) => ({
            from: (table: unknown) => ({
              where: (condition: unknown) => {
                if (table === departmentsTable) {
                  return { for: async () => state.departmentRows };
                }
                if (table === usersTable) {
                  if (
                    typeof condition === "object" &&
                    condition !== null &&
                    "values" in condition
                  ) {
                    const ids = (condition as { values: number[] }).values;
                    return {
                      orderBy: () => ({
                        for: async () =>
                          [state.lockedActor, ...state.extraUsers]
                            .filter((user) => ids.includes(user.id as number))
                            .sort(
                              (left, right) =>
                                (left.id as number) - (right.id as number),
                            ),
                      }),
                    };
                  }
                  if (
                    typeof condition === "object" &&
                    condition !== null &&
                    "column" in condition &&
                    (condition as { column: unknown }).column === usersTable.id
                  ) {
                    return { for: async () => [state.lockedActor] };
                  }
                  return Promise.resolve(state.existingEmailRows);
                }
                if (table === facilitiesTable) {
                  return Promise.resolve(state.facilityRows);
                }
                if (table === employeeInvitationsTable) {
                  return {
                    for: async () =>
                      state.lockedInvitation ? [state.lockedInvitation] : [],
                  };
                }
                throw new Error("Unexpected select table");
              },
            }),
          }),
          update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => ({
              where: () => {
                if (table === employeeInvitationsTable) {
                  state.priorRevocation = values;
                  return {
                    returning: async (
                      selection: Record<string, unknown> | undefined,
                    ) => {
                      state.providerFailureRevocation = true;
                      const row = state.lockedInvitation ?? {
                        id: 81,
                        facilityId: 10,
                        name: "New Worker",
                        nameAr: "موظف جديد",
                      };
                      return [projectSelection(row, selection)];
                    },
                  };
                }
                throw new Error("Unexpected update table");
              },
            }),
          }),
          insert: (table: unknown) => ({
            values: (values: Record<string, unknown>) => {
              if (table === employeeInvitationsTable) {
                state.invitationValues = values;
                return { returning: async () => [{ id: 81 }] };
              }
              if (table === auditLogsTable) {
                if (values.action === "Created employee invitation") {
                  state.invitationAudit = values;
                } else if (
                  values.action === "Revoked undelivered employee invitation"
                ) {
                  if (state.providerFailureAuditFails) {
                    throw new Error("audit storage failed");
                  }
                  state.providerFailureAudit = values;
                } else if (values.action === "Revoked employee invitation") {
                  state.revokeAudit = values;
                }
                return Promise.resolve();
              }
              throw new Error("Unexpected insert table");
            },
          }),
        };
        return callback(tx);
      }),
    },
  };
});

vi.mock("../lib/auth", () => ({
  ADMIN_ROLES: ["hospital_admin", "system_admin"],
  MANAGER_ROLES: [
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ],
  getUser: vi.fn(() => state.actor),
  hashPassword: vi.fn(async () => "unused"),
  comparePassword: state.comparePassword,
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole:
    (..._roles: string[]) =>
    (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

vi.mock("../lib/secondFactor", () => ({
  consumeSecondFactor: state.consumeSecondFactor,
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

vi.mock("../lib/email/sender", () => ({
  createEmailIdempotencyKey: vi.fn(() => `healthdocs-${"a".repeat(64)}`),
  isEmailConfigured: vi.fn(() => state.emailConfigured),
  sendEmail: state.sendEmail,
}));

vi.mock("../lib/email/templates", () => ({
  getEmployeeInvitationUrl: vi.fn(
    (token: string) =>
      `https://app.wathaiqihealth.com/register#token=${encodeURIComponent(token)}`,
  ),
  employeeInvitationEmail: vi.fn(
    ({ invitationUrl }: { invitationUrl: string }) => invitationUrl,
  ),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn() },
}));

vi.mock("../lib/roleHierarchy", () => ({
  canAssignRole: vi.fn(() => true),
  canManageTarget: vi.fn(() => true),
  isUserInScope: vi.fn(() => true),
}));

vi.mock("../lib/helpers", () => ({
  computeEmployeeStats: vi.fn(),
  employeeSummary: vi.fn(),
  getCredentialScopedUsers: vi.fn(),
  getCredentialsFor: vi.fn(),
  getDepartments: vi.fn(),
  getPolicies: vi.fn(),
  serializeCredential: vi.fn(),
  serializeUser: vi.fn(),
}));

import router from "./employees";

describe("invite-only employee registration provisioning", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    Object.assign(state.actor, {
      id: 1,
      role: "hospital_admin",
      facilityId: 10,
      isActive: true,
      sessionVersion: 4,
      passwordHash: "admin-hash",
      totpEnabled: true,
      totpSecret: "encrypted-secret",
      name: "Facility Admin",
      nameAr: "مدير المنشأة",
    });
    state.lockedActor = { ...state.actor };
    state.emailConfigured = true;
    state.extraUsers = [];
    state.departmentRows = [];
    state.facilityRows = [{ id: 10 }];
    state.existingEmailRows = [];
    state.invitationValues = null;
    state.invitationAudit = null;
    state.providerFailureAudit = null;
    state.revokeAudit = null;
    state.priorRevocation = null;
    state.providerFailureRevocation = false;
    state.providerFailureAuditFails = false;
    state.providerFailureFallbackRevocation = false;
    state.invitationListRows = [];
    state.invitationListSelection = null;
    state.invitationListWhere = null;
    state.lockedInvitation = null;
    state.transactionCount = 0;
    state.comparePassword.mockClear();
    state.consumeSecondFactor.mockReset();
    state.consumeSecondFactor.mockImplementation(async (_tx, actor) => actor);
    state.sendEmail.mockReset();
    state.sendEmail.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function invite(
    overrides: Record<string, unknown> = {},
  ): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    app.use(
      (_error: unknown, _req: Request, res: Response, _next: NextFunction) =>
        res.status(500).json({ message: "Internal server error" }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return fetch(`http://127.0.0.1:${address.port}/api/employees/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "New Worker",
        nameAr: "موظف جديد",
        email: "NEW.WORKER@example.sa",
        jobTitle: "Nurse",
        jobTitleAr: "ممرض",
        employeeNumber: "EMP-2",
        currentPassword: " admin password ",
        code: "123456",
        ...overrides,
      }),
    });
  }

  async function invitationRequest(
    path = "/api/employees/invitations",
    init?: RequestInit,
  ): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use("/api", router);
    app.use(
      (_error: unknown, _req: Request, res: Response, _next: NextFunction) =>
        res.status(500).json({ message: "Internal server error" }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return fetch(`http://127.0.0.1:${address.port}${path}`, init);
  }

  it("stores only a token hash, sends the fragment link, and never returns the raw token", async () => {
    const before = Date.now();
    const response = await invite();
    const responseBody = await response.json();

    expect(response.status).toBe(201);
    expect(responseBody).toEqual(expect.objectContaining({ status: "sent" }));
    expect(state.invitationValues).toEqual(
      expect.objectContaining({
        email: "new.worker@example.sa",
        invitedBy: 1,
        facilityId: 10,
      }),
    );
    expect(state.invitationValues?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const email = state.sendEmail.mock.calls[0]?.[0] as { html: string };
    const rawToken = email.html.match(/#token=([0-9a-f]{64})$/)?.[1];
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(state.invitationValues)).not.toContain(rawToken);
    expect(JSON.stringify(responseBody)).not.toContain(rawToken);
    expect(
      (state.invitationValues?.expiresAt as Date).getTime(),
    ).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1_000);
    expect(state.invitationAudit).toEqual(
      expect.objectContaining({
        action: "Created employee invitation",
        facilityId: 10,
      }),
    );
    expect(state.comparePassword).toHaveBeenCalledWith(
      " admin password ",
      "admin-hash",
    );
  });

  it("fails closed before persistence when email delivery is unavailable", async () => {
    state.emailConfigured = false;

    const response = await invite();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "email_delivery_unavailable" }),
    );
    expect(state.transactionCount).toBe(0);
    expect(state.sendEmail).not.toHaveBeenCalled();
  });

  it("rechecks the locked administrator role", async () => {
    state.lockedActor.role = "department_manager";

    const response = await invite();

    expect(response.status).toBe(403);
    expect(state.invitationValues).toBeNull();
    expect(state.sendEmail).not.toHaveBeenCalled();
  });

  it("requires a consumed second factor for every invitation", async () => {
    state.consumeSecondFactor.mockResolvedValueOnce(null);

    const response = await invite();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "step_up_failed" }),
    );
    expect(state.invitationValues).toBeNull();
  });

  it("rejects a department outside the administrator-derived facility", async () => {
    state.departmentRows = [{ id: 7, facilityId: 99 }];

    const response = await invite({ departmentId: 7, facilityId: 99 });

    expect(response.status).toBe(400);
    expect(state.invitationValues).toBeNull();
  });

  it("revokes the stored invitation when the provider fails", async () => {
    state.sendEmail.mockRejectedValueOnce(new Error("provider failure"));

    const response = await invite();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "invitation_delivery_failed" }),
    );
    expect(state.providerFailureRevocation).toBe(true);
    expect(state.providerFailureAudit).toEqual(
      expect.objectContaining({
        action: "Revoked undelivered employee invitation",
        facilityId: 10,
      }),
    );
    expect(state.transactionCount).toBe(2);
  });

  it("fails closed with a direct revocation if provider-failure audit persistence fails", async () => {
    state.sendEmail.mockRejectedValueOnce(new Error("provider failure"));
    state.providerFailureAuditFails = true;

    const response = await invite();

    expect(response.status).toBe(502);
    expect(state.providerFailureFallbackRevocation).toBe(true);
    expect(state.providerFailureAudit).toBeNull();
  });

  it("lists only projected active invitation fields in the hospital facility scope", async () => {
    state.invitationListRows = [
      {
        id: 91,
        email: "worker@example.sa",
        name: "Worker",
        nameAr: "موظف",
        jobTitle: "Nurse",
        jobTitleAr: "ممرض",
        employeeNumber: "EMP-91",
        phone: null,
        facilityId: 10,
        departmentId: null,
        supervisorId: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        tokenHash: "secret-token-digest",
      },
    ];

    const response = await invitationRequest();
    const body = (await response.json()) as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).not.toHaveProperty("tokenHash");
    expect(state.invitationListSelection).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(state.invitationListWhere)).toContain(
      '"column":"employeeInvitations.facilityId","value":10',
    );
  });

  it("honors a system administrator facility filter without exposing token digests", async () => {
    state.actor.role = "system_admin";
    state.lockedActor = { ...state.actor };

    const response = await invitationRequest(
      "/api/employees/invitations?facilityId=99",
    );

    expect(response.status).toBe(200);
    expect(JSON.stringify(state.invitationListWhere)).toContain(
      '"column":"employeeInvitations.facilityId","value":99',
    );
    expect(state.invitationListSelection).not.toHaveProperty("tokenHash");
  });

  it("revokes an active invitation with exact-password and consumed-code step-up", async () => {
    state.lockedInvitation = {
      id: 91,
      facilityId: 10,
      name: "Worker",
      nameAr: "موظف",
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    const response = await invitationRequest("/api/employees/invitations/91", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: " admin password ",
        code: " 123456 ",
      }),
    });

    expect(response.status).toBe(204);
    expect(state.comparePassword).toHaveBeenCalledWith(
      " admin password ",
      "admin-hash",
    );
    expect(state.consumeSecondFactor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 1 }),
      "123456",
    );
    expect(state.revokeAudit).toEqual(
      expect.objectContaining({
        action: "Revoked employee invitation",
        facilityId: 10,
        target: "Worker",
      }),
    );
    expect(JSON.stringify(state.revokeAudit)).not.toContain("example.sa");
  });

  it("uses the same not-found response for missing and cross-facility invitations", async () => {
    const missingResponse = await invitationRequest(
      "/api/employees/invitations/91",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: " admin password ",
          code: "123456",
        }),
      },
    );
    const missingBody = await missingResponse.json();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;

    state.lockedInvitation = {
      id: 91,
      facilityId: 99,
      name: "Other Worker",
      nameAr: "موظف آخر",
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const crossFacilityResponse = await invitationRequest(
      "/api/employees/invitations/91",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: " admin password ",
          code: "123456",
        }),
      },
    );
    const crossFacilityBody = await crossFacilityResponse.json();

    expect(missingResponse.status).toBe(404);
    expect(crossFacilityResponse.status).toBe(404);
    expect(crossFacilityBody).toEqual(missingBody);
    expect(state.comparePassword).not.toHaveBeenCalled();
    expect(state.consumeSecondFactor).not.toHaveBeenCalled();
    expect(state.revokeAudit).toBeNull();
  });

  it.each([
    ["accepted", { acceptedAt: new Date(), revokedAt: null }],
    ["revoked", { acceptedAt: null, revokedAt: new Date() }],
    [
      "expired",
      {
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      },
    ],
  ])(
    "returns generic not-found for a %s invitation",
    async (_state, terminal) => {
      state.lockedInvitation = {
        id: 91,
      facilityId: 10,
      name: "Worker",
      nameAr: "موظف",
      expiresAt: new Date(Date.now() + 60_000),
      ...terminal,
      };

      const response = await invitationRequest(
        "/api/employees/invitations/91",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentPassword: " admin password ",
            code: "123456",
          }),
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        message: "Invitation not found",
      });
      expect(state.comparePassword).not.toHaveBeenCalled();
      expect(state.consumeSecondFactor).not.toHaveBeenCalled();
    },
  );

  it("rechecks the locked administrator role before revocation", async () => {
    state.lockedActor.role = "department_manager";
    state.lockedInvitation = {
      id: 91,
      facilityId: 10,
      name: "Worker",
      nameAr: "موظف",
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    const response = await invitationRequest("/api/employees/invitations/91", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: " admin password ",
        code: "123456",
      }),
    });

    expect(response.status).toBe(403);
    expect(state.comparePassword).not.toHaveBeenCalled();
    expect(state.consumeSecondFactor).not.toHaveBeenCalled();
    expect(state.revokeAudit).toBeNull();
  });

  it("rejects extra revoke fields before consuming administrator factors", async () => {
    const response = await invitationRequest("/api/employees/invitations/91", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: " admin password ",
        code: "123456",
        facilityId: 99,
      }),
    });

    expect(response.status).toBe(400);
    expect(state.transactionCount).toBe(0);
    expect(state.consumeSecondFactor).not.toHaveBeenCalled();
  });
});
