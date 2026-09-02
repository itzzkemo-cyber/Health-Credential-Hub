import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Real HTTP routes, JWT authentication, scope helpers and serializers; only
// persistence, object transport and second-factor consumption are adapters.
// These synthetic tests do not prove PostgreSQL locking or live account setup.
const state = vi.hoisted(() => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousProtectedMfaUserId = process.env.PROTECTED_MFA_USER_ID;
  process.env.SESSION_SECRET =
    "synthetic-tenant-isolation-test-secret-not-for-runtime";
  // Fixture 4 is the protected Abdulkarim-equivalent account in this matrix.
  // Keeping the immutable identity explicit also prevents employee fixture 1
  // from accidentally inheriting the non-production fallback policy.
  process.env.PROTECTED_MFA_USER_ID = "4";
  return {
    previousSecret,
    previousProtectedMfaUserId,
    users: [] as Record<string, any>[],
    credentials: [] as Record<string, any>[],
    writes: [] as { table: string; values: Record<string, any> }[],
    queries: [] as { table: string; rows: number[] }[],
    download: vi.fn(),
    secondFactor: vi.fn(async (_tx: unknown, actor: unknown) => actor),
    forceAcl: false,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown) => (row: Record<string, unknown>) =>
    row[column] === value,
  inArray:
    (column: string, values: unknown[]) => (row: Record<string, unknown>) =>
      values.includes(row[column]),
  isNull: (column: string) => (row: Record<string, unknown>) =>
    row[column] == null,
  and:
    (...conditions: ((row: Record<string, unknown>) => boolean)[]) =>
    (row: Record<string, unknown>) =>
      conditions.every((condition) => condition(row)),
  desc: (column: string) => column,
  gt: (column: string, value: number) => (row: Record<string, any>) =>
    row[column] > value,
  sql: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const table = (name: string) =>
    new Proxy(
      { name },
      { get: (target, key) => (key === "name" ? target.name : String(key)) },
    );
  const usersTable = table("users");
  const credentialsTable = table("credentials");
  const db: any = {
    select: (selection?: Record<string, string>) => ({
      from: (source: { name: string }) => {
        let predicate = (_row: Record<string, any>) => true;
        const read = () => {
          const all =
            source.name === "users"
              ? state.users
              : source.name === "credentials"
                ? state.credentials
                : source.name === "facilities"
                  ? [{ id: 10 }, { id: 20 }]
                  : [];
          const rows = all.filter(predicate);
          state.queries.push({
            table: source.name,
            rows: rows.map((row) => row.id),
          });
          return selection
            ? rows.map((row) =>
                Object.fromEntries(
                  Object.entries(selection).map(([key, column]) => [
                    key,
                    row[column],
                  ]),
                ),
              )
            : rows;
        };
        const query: any = {
          where: (filter: typeof predicate) => {
            predicate = filter;
            return query;
          },
          orderBy: () => query,
          for: async () => read(),
          then: (
            resolve: (value: unknown) => unknown,
            reject: (error: unknown) => unknown,
          ) => Promise.resolve(read()).then(resolve, reject),
        };
        return query;
      },
    }),
    insert: (source: { name: string }) => ({
      values: (values: Record<string, any>) => {
        state.writes.push({ table: source.name, values });
        const completion = Promise.resolve() as Promise<void> & {
          returning: () => Promise<unknown[]>;
        };
        completion.returning = async () => [
          { id: 999, createdAt: new Date(), ...values },
        ];
        return completion;
      },
    }),
    update: () => {
      throw new Error("A denied authorization request attempted a write");
    },
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db),
  };
  return {
    db,
    usersTable,
    credentialsTable,
    facilitiesTable: table("facilities"),
    departmentsTable: table("departments"),
    auditLogsTable: table("audit"),
    notificationsTable: table("notifications"),
    credentialPoliciesTable: table("policies"),
    employeeInvitationsTable: table("invitations"),
    uploadGrantsTable: table("grants"),
    automationOutboxTable: table("outbox"),
    CREDENTIAL_TYPES: ["BLS"],
    USER_ROLES: [
      "employee",
      "supervisor",
      "department_manager",
      "hospital_admin",
      "system_admin",
    ],
  };
});
vi.mock("../lib/secondFactor", () => ({
  consumeSecondFactor: state.secondFactor,
}));
vi.mock("../lib/rateLimit", () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/email/sender", () => ({
  isEmailConfigured: () => false,
  createEmailIdempotencyKey: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("@workspace/integrations-gemini-ai", () => ({ getAi: vi.fn() }));
vi.mock("../lib/objectStorage", () => ({
  ObjectNotFoundError: class extends Error {},
  ObjectAlreadyExistsError: class extends Error {},
  getObjectStorageProvider: () => "s3",
  ObjectStorageService: class {
    getObjectEntityFile = async (path: string) => ({ path });
    canAccessObjectEntity = async ({
      userId,
      objectFile,
    }: {
      userId: string;
      objectFile: { path: string };
    }) =>
      state.forceAcl ||
      state.credentials.some(
        (row) =>
          row.fileUrl === objectFile.path && String(row.employeeId) === userId,
      );
    downloadObject = state.download;
  },
}));
vi.mock("../lib/uploadSecurity", () => ({
  ALLOWED_UPLOAD_CONTENT_TYPE: /^(image\/jpeg|image\/png)$/,
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  UPLOAD_GRANT_TTL_MS: 900000,
  findActiveUploadGrant: async () => null,
  validateUploadedObject: vi.fn(),
}));

import { hashPassword, signToken, signPurposeToken } from "../lib/auth";
import credentialRouter from "./credentials";
import employeeRouter from "./employees";
import storageRouter from "./storage";

const roles = [
  "employee",
  "supervisor",
  "department_manager",
  "hospital_admin",
  "system_admin",
] as const;
let passwordHash = "";
function fixture(
  id: number,
  role: (typeof roles)[number],
  facilityId: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    role,
    facilityId,
    departmentId: facilityId + 1,
    supervisorId: null,
    isActive: true,
    sessionVersion: 1,
    mustChangePassword: false,
    totpEnabled: role !== "employee",
    totpSecret: "synthetic-encrypted-secret",
    passwordHash,
    name: `Synthetic ${id}`,
    nameAr: `اختبار ${id}`,
    email: `synthetic-${id}@example.invalid`,
    jobTitle: "Synthetic",
    jobTitleAr: "اختبار",
    employeeNumber: `S-${id}`,
    createdAt: new Date("2026-01-01"),
    ...extra,
  };
}

describe("two-facility server-side authorization matrix", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let origin = "";
  beforeAll(async () => {
    passwordHash = await hashPassword("Synthetic-admin-password-only");
  });
  beforeEach(async () => {
    state.users = [
      ...roles.map((role, index) => fixture(index + 1, role, 10)),
      ...roles.map((role, index) => fixture(index + 11, role, 20)),
      fixture(21, "employee", 10, { supervisorId: 2 }),
      fixture(22, "employee", 10, { departmentId: 99 }),
      fixture(23, "supervisor", 10, { supervisorId: 2 }), // invalid legacy peer edge must not grant evidence access
    ];
    state.credentials = state.users.map((user) => ({
      id: 100 + user.id,
      employeeId: user.id,
      type: "BLS",
      holderName: user.name,
      holderNameAr: user.nameAr,
      issuerName: "Synthetic",
      issuerNameAr: "اختبار",
      certificateNumber: `S-${user.id}`,
      issueDate: "2026-01-01",
      expiryDate: "2030-01-01",
      isVerified: true,
      fileUrl: `/objects/uploads/synthetic-${user.id}`,
      fileType: "image/jpeg",
      qrToken: `synthetic-qr-${user.id}`,
      deletedAt: null,
      rowVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    state.credentials.push({
      ...state.credentials[0],
      id: 999,
      deletedAt: new Date(),
      fileUrl: "/objects/uploads/deleted",
    });
    state.writes = [];
    state.queries = [];
    state.forceAcl = false;
    state.secondFactor.mockClear();
    state.download.mockReset();
    state.download.mockImplementation(
      async () =>
        new Response("synthetic bytes", {
          headers: { "Content-Type": "image/jpeg" },
        }),
    );
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { log: { error: vi.fn(), warn: vi.fn() } });
      next();
    });
    app.use("/api", credentialRouter, employeeRouter, storageRouter);
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => res.status(500).json({ error: "test handler error" }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test listener");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    server = undefined;
  });
  afterAll(() => {
    if (state.previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = state.previousSecret;
    if (state.previousProtectedMfaUserId === undefined) {
      delete process.env.PROTECTED_MFA_USER_ID;
    } else {
      process.env.PROTECTED_MFA_USER_ID = state.previousProtectedMfaUserId;
    }
  });
  function request(
    path: string,
    actorId?: number,
    body?: Record<string, unknown>,
    method = body ? "POST" : "GET",
    token?: string,
  ) {
    return fetch(`${origin}/api${path}`, {
      method,
      headers: {
        ...(actorId
          ? { Authorization: `Bearer ${token ?? signToken(actorId, 1)}` }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const matrix = [
    { role: "employee", actor: 1, visible: [1] },
    { role: "supervisor", actor: 2, visible: [2, 21] },
    { role: "department_manager", actor: 3, visible: [1, 2, 3, 21, 23] },
    { role: "hospital_admin", actor: 4, visible: [1, 2, 3, 4, 21, 22, 23] },
    {
      role: "system_admin",
      actor: 5,
      visible: [1, 2, 3, 4, 5, 11, 12, 13, 14, 21, 22, 23],
    },
  ];
  it.each(matrix)(
    "$role credential list applies real scope helpers before returning rows",
    async ({ actor, visible }) => {
      const response = await request("/credentials?pageSize=100", actor);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<{ employeeId: number }>;
      };
      expect(
        body.data
          .map((row: { employeeId: number }) => row.employeeId)
          .sort((a: number, b: number) => a - b),
      ).toEqual(visible);
      expect(
        state.queries
          .filter((query) => query.table === "credentials")
          .at(-1)
          ?.rows.sort((a, b) => a - b),
      ).toEqual(visible.map((id) => id + 100));
    },
  );
  it("returns public verification data only for an approved credential", async () => {
    const token = "a".repeat(32);
    state.credentials[0].qrToken = token;

    const response = await request(`/credentials/${token}/verify`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      verificationState: "verified",
      type: "BLS",
      issuerName: "Synthetic",
      status: "active",
      verificationCode: "AAAAAAAA",
    });
    expect(body).not.toHaveProperty("holderName");
    expect(body).not.toHaveProperty("certificateNumber");
    expect(body).not.toHaveProperty("employeeId");
  });
  it("returns only a pending state for a valid unapproved QR token", async () => {
    const token = "b".repeat(32);
    state.credentials[0].qrToken = token;
    state.credentials[0].isVerified = false;

    const response = await request(`/credentials/${token}/verify`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ verificationState: "pending" });
  });
  it("keeps malformed, deleted, and unknown QR tokens indistinguishable", async () => {
    const deletedToken = "d".repeat(32);
    state.credentials.at(-1)!.qrToken = deletedToken;

    for (const token of ["not-a-token", deletedToken, "e".repeat(32)]) {
      const response = await request(`/credentials/${token}/verify`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ message: "Credential not found" });
    }
  });
  it.each(
    matrix.flatMap((entry) =>
      [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 21, 22, 23].map((owner) => ({
        ...entry,
        owner,
        allowed: entry.visible.includes(owner),
      })),
    ),
  )(
    "$role direct credential/file access to owner $owner is $allowed",
    async ({ actor, owner, allowed }) => {
      const response = await request(`/credentials/${100 + owner}`, actor);
      expect(response.status).toBe(allowed ? 200 : 404);
      const file = await request(
        `/storage/objects/uploads/synthetic-${owner}`,
        actor,
      );
      expect(file.status).toBe(allowed ? 200 : 404);
      if (allowed) {
        expect(await file.text()).toBe("synthetic bytes");
        expect(file.headers.get("cache-control")).toBe(
          "private, no-store, max-age=0",
        );
        expect(
          state.writes.find((entry) => entry.table === "audit")?.values
            .facilityId,
        ).toBe(state.users.find((user) => user.id === owner)?.facilityId);
      } else {
        expect(state.download).not.toHaveBeenCalled();
        expect(state.writes).toEqual([]);
      }
    },
  );
  it.each(matrix)(
    "$role cannot self-promote or mutate their own facility",
    async ({ actor }) => {
      const response = await request(
        `/employees/${actor}`,
        actor,
        {
          role: "system_admin",
          facilityId: 20,
          currentPassword: "Synthetic-admin-password-only",
          code: "000000",
        },
        "PATCH",
      );
      expect(response.status).toBe(403);
      expect(state.writes).toEqual([]);
      expect(state.secondFactor).not.toHaveBeenCalled();
    },
  );
  it.each(
    roles.flatMap((actorRole, index) =>
      roles.map((targetRole, targetRank) => ({
        actorRole,
        actor: index + 1,
        targetRole,
        allowed: index === 4 ? targetRank < 4 : index === 3 && targetRank < 3,
      })),
    ),
  )(
    "$actorRole delegates $targetRole only when allowed=$allowed",
    async ({ actor, targetRole, allowed }) => {
      const response = await request("/employees", actor, {
        name: "Synthetic New",
        nameAr: "اختبار جديد",
        email: `new-${actor}-${targetRole}@example.invalid`,
        password: "Synthetic-new-password-only",
        role: targetRole,
        jobTitle: "Synthetic",
        jobTitleAr: "اختبار",
        employeeNumber: "S-NEW",
        facilityId: 20,
        currentPassword: "Synthetic-admin-password-only",
        code: "000000",
      });
      expect(response.status).toBe(allowed ? 201 : 403);
      if (allowed) {
        expect(
          state.writes.find((entry) => entry.table === "users")?.values,
        ).toMatchObject({
          role: targetRole,
          facilityId: actor === 5 ? 20 : 10,
          mustChangePassword: true,
        });
        if (actor === 4) {
          expect(state.secondFactor).toHaveBeenCalledOnce();
        } else {
          expect(state.secondFactor).not.toHaveBeenCalled();
        }
        const body = await response.json();
        expect(body).not.toHaveProperty("passwordHash");
        expect(body).not.toHaveProperty("totpSecret");
      } else {
        expect(state.writes).toEqual([]);
        expect(state.secondFactor).not.toHaveBeenCalled();
      }
    },
  );
  it.each(matrix)(
    "$role cannot verify their own evidence",
    async ({ actor }) => {
      const response = await request(
        `/credentials/${actor + 100}`,
        actor,
        { expectedVersion: 1, isVerified: true },
        "PATCH",
      );
      expect(response.status).toBe(403);
      expect(state.writes).toEqual([]);
    },
  );
  it("stale object ACL never grants an unrelated employee access to a linked document", async () => {
    state.forceAcl = true;
    expect(
      (await request("/storage/objects/uploads/synthetic-11", 1)).status,
    ).toBe(404);
    expect(state.download).not.toHaveBeenCalled();
  });
  it.each([
    "/credentials/101",
    "/storage/objects/uploads/synthetic-1",
    "/employees",
  ])(
    "rejects anonymous requests to %s before persistence or storage",
    async (path) => {
      expect((await request(path)).status).toBe(401);
      expect(state.queries).toEqual([]);
      expect(state.download).not.toHaveBeenCalled();
    },
  );
  it.each([
    "revoked",
    "inactive",
    "challenge",
    "mfa-required",
    "password-change-required",
  ])("enforces real authentication gate: %s", async (condition) => {
    const actor = state.users.find((user) => user.id === 4)!;
    let token = signToken(4, 1);
    if (condition === "revoked") actor.sessionVersion = 2;
    if (condition === "inactive") actor.isActive = false;
    if (condition === "challenge")
      token = signPurposeToken("2fa_challenge", 4, { v: 1 }, "5m");
    if (condition === "mfa-required") actor.totpEnabled = false;
    if (condition === "password-change-required")
      actor.mustChangePassword = true;
    const expected = condition.endsWith("required") ? 403 : 401;
    expect(
      (await request("/credentials/101", 4, undefined, "GET", token)).status,
    ).toBe(expected);
    expect(
      (
        await request(
          "/storage/objects/uploads/synthetic-1",
          4,
          undefined,
          "GET",
          token,
        )
      ).status,
    ).toBe(expected);
    expect(state.download).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
  it("soft-deleted evidence is unavailable even to its owner", async () => {
    expect((await request("/credentials/999", 1)).status).toBe(404);
    expect((await request("/storage/objects/uploads/deleted", 1)).status).toBe(
      404,
    );
    expect(state.download).not.toHaveBeenCalled();
  });
});
