import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: { id: 1, role: "hospital_admin", facilityId: 10, isActive: true },
  employee: { id: 2, role: "employee", facilityId: 10, isActive: true },
  otherEmployee: { id: 3, role: "employee", facilityId: 10, isActive: true },
  getCredentialScopedUsers: vi.fn(),
  getObjectEntityFile: vi.fn(),
  canAccessObjectEntity: vi.fn(),
  getObjectAclPolicy: vi.fn(),
  findActiveUploadGrant: vi.fn(),
  dbSelect: vi.fn(),
  dbWhere: vi.fn(),
  getAi: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  auditLogsTable: {},
  automationOutboxTable: {},
  credentialsTable: {
    employeeId: "employeeId",
    fileUrl: "fileUrl",
    deletedAt: "deletedAt",
  },
  db: { select: mocks.dbSelect },
  notificationsTable: {},
  uploadGrantsTable: {},
  usersTable: {},
  CREDENTIAL_TYPES: ["BLS", "custom"],
}));

vi.mock("../lib/auth", () => ({
  MANAGER_ROLES: [
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ],
  getUser: vi.fn(() => mocks.actor),
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../lib/helpers", () => ({
  computeStatus: vi.fn(() => "active"),
  dateStr: vi.fn(),
  daysUntil: vi.fn(),
  evaluateCredentialVerificationChange: vi.fn(),
  getCredentialScopedUsers: mocks.getCredentialScopedUsers,
  getCredentialsFor: vi.fn(),
  getPolicies: vi.fn(),
  logAudit: vi.fn(),
  missingTypesFor: vi.fn(),
  serializeCredential: vi.fn((credential: unknown) => credential),
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectNotFoundError: class extends Error {},
  ObjectStorageService: class {
    getObjectEntityFile = mocks.getObjectEntityFile;
    canAccessObjectEntity = mocks.canAccessObjectEntity;
  },
}));

vi.mock("../lib/objectAcl", () => ({
  ObjectPermission: { READ: "read", WRITE: "write" },
  getObjectAclPolicy: mocks.getObjectAclPolicy,
  setObjectAclPolicy: vi.fn(),
}));

vi.mock("../lib/uploadSecurity", () => ({
  ALLOWED_UPLOAD_CONTENT_TYPE: /^image\/(?:jpeg|png)$/,
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  findActiveUploadGrant: mocks.findActiveUploadGrant,
  validateUploadedObject: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  gt: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  inArray: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  isNotNull: vi.fn((value: unknown) => ({ value })),
  isNull: vi.fn((value: unknown) => ({ value })),
  sql: vi.fn(),
}));

vi.mock("@workspace/integrations-gemini-ai", () => ({
  getAi: mocks.getAi,
}));

import router from "./credentials";

const OCR_ENV_NAMES = [
  "OCR_ENABLED",
  "OCR_FACILITY_ALLOWLIST",
  "OCR_PROVIDER_HOST_ALLOWLIST",
  "AI_INTEGRATIONS_GEMINI_BASE_URL",
  "AI_INTEGRATIONS_GEMINI_API_KEY",
] as const;
const originalEnv = Object.fromEntries(
  OCR_ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof OCR_ENV_NAMES)[number], string | undefined>;

function enableOcr(facilities = "10"): void {
  process.env.OCR_ENABLED = "true";
  process.env.OCR_FACILITY_ALLOWLIST = facilities;
  process.env.OCR_PROVIDER_HOST_ALLOWLIST = "vertex.example.sa";
  process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = "https://vertex.example.sa/v1";
  process.env.AI_INTEGRATIONS_GEMINI_API_KEY = "runtime-secret";
}

describe("facility-scoped OCR release gate", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    for (const name of OCR_ENV_NAMES) delete process.env[name];
    mocks.getCredentialScopedUsers.mockReset();
    mocks.getCredentialScopedUsers.mockResolvedValue([
      mocks.actor,
      mocks.employee,
      mocks.otherEmployee,
    ]);
    mocks.getObjectEntityFile.mockReset();
    mocks.canAccessObjectEntity.mockReset();
    mocks.getObjectAclPolicy.mockReset();
    mocks.findActiveUploadGrant.mockReset();
    mocks.dbSelect.mockReset();
    mocks.dbWhere.mockReset();
    mocks.dbSelect.mockReturnValue({
      from: vi.fn(() => ({ where: mocks.dbWhere })),
    });
    mocks.getAi.mockReset();
    mocks.logError.mockReset();
  });

  afterEach(async () => {
    for (const name of OCR_ENV_NAMES) {
      const original = originalEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function request(
    path: string,
    init?: RequestInit,
  ): Promise<globalThis.Response> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, { log: { error: mocks.logError } });
      next();
    });
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(`http://127.0.0.1:${address.port}/api${path}`, init);
  }

  it("reports OCR disabled by default without querying employee scope", async () => {
    const response = await request("/credentials/ocr/readiness?employeeId=2");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disabled" });
    expect(mocks.getCredentialScopedUsers).not.toHaveBeenCalled();
  });

  it("reports enabled only for an authorized employee in an allowed facility", async () => {
    enableOcr("10");
    const response = await request("/credentials/ocr/readiness?employeeId=2");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "enabled" });
    expect(mocks.getCredentialScopedUsers).toHaveBeenCalledWith(mocks.actor);
  });

  it("keeps an unlisted facility disabled", async () => {
    enableOcr("20");
    const response = await request("/credentials/ocr/readiness?employeeId=2");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disabled" });
  });

  it("rejects OCR before storage or provider access when the gate is off", async () => {
    const response = await request("/credentials/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        employeeId: 2,
        fileUrl: "/objects/uploads/123e4567-e89b-42d3-a456-426614174000",
      }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "OCR_UNAVAILABLE" });
    expect(mocks.getCredentialScopedUsers).not.toHaveBeenCalled();
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.getAi).not.toHaveBeenCalled();
  });

  it("rejects an out-of-scope employee before storage or provider access", async () => {
    enableOcr("10");
    mocks.getCredentialScopedUsers.mockResolvedValue([mocks.actor]);
    const response = await request("/credentials/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        employeeId: 2,
        fileUrl: "/objects/uploads/123e4567-e89b-42d3-a456-426614174000",
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.getObjectEntityFile).not.toHaveBeenCalled();
    expect(mocks.getAi).not.toHaveBeenCalled();
  });

  it("rejects a linked document that belongs to a different in-facility employee", async () => {
    enableOcr("10");
    const objectFile = { name: "private-object" };
    mocks.getObjectEntityFile.mockResolvedValue(objectFile);
    mocks.findActiveUploadGrant.mockResolvedValue(null);
    mocks.getObjectAclPolicy.mockResolvedValue({ owner: "1" });
    mocks.canAccessObjectEntity.mockResolvedValue(false);
    // Even if a stale or mocked query returns another employee's row, the
    // target-specific ownership check must fail closed.
    mocks.dbWhere.mockResolvedValue([{ employeeId: 3 }]);

    const response = await request("/credentials/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        employeeId: 2,
        fileUrl: "/objects/uploads/123e4567-e89b-42d3-a456-426614174000",
      }),
    });

    expect(response.status).toBe(403);
    expect(mocks.dbWhere).toHaveBeenCalledTimes(1);
    expect(mocks.getAi).not.toHaveBeenCalled();
  });
});
