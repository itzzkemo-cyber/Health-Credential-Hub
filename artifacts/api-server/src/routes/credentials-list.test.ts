import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: { id: 1, role: "hospital_admin", facilityId: 10, isActive: true },
  employee: { id: 2, role: "employee", facilityId: 10, isActive: true },
  getCredentialScopedUsers: vi.fn(),
  getCredentialsFor: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  auditLogsTable: {},
  automationOutboxTable: {},
  credentialsTable: {},
  db: {},
  notificationsTable: {},
  uploadGrantsTable: {},
  usersTable: {},
  CREDENTIAL_TYPES: ["BLS"],
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
  getCredentialsFor: mocks.getCredentialsFor,
  getPolicies: vi.fn(),
  logAudit: vi.fn(),
  missingTypesFor: vi.fn(),
  serializeCredential: vi.fn((credential: unknown) => credential),
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectNotFoundError: class extends Error {},
  ObjectStorageService: class {},
}));

vi.mock("../lib/objectAcl", () => ({
  ObjectPermission: { READ: "read", WRITE: "write" },
  getObjectAclPolicy: vi.fn(),
  setObjectAclPolicy: vi.fn(),
}));

vi.mock("../lib/uploadSecurity", () => ({
  ALLOWED_UPLOAD_CONTENT_TYPE: {},
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  findActiveUploadGrant: vi.fn(),
  validateUploadedObject: vi.fn(),
}));

vi.mock("@workspace/integrations-gemini-ai", () => ({ getAi: vi.fn() }));

import router from "./credentials";

function credential(id: number, isVerified: boolean) {
  return {
    id,
    employeeId: mocks.employee.id,
    type: "BLS",
    certificateNumber: `CERT-${id}`,
    holderName: "Employee",
    holderNameAr: "موظف",
    issuerName: "Issuer",
    issuerNameAr: "جهة",
    issueDate: "2026-01-01",
    expiryDate: isVerified ? "2026-06-01" : "2027-06-01",
    isVerified,
  };
}

describe("credential verification queue pagination", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    mocks.getCredentialScopedUsers.mockReset();
    mocks.getCredentialsFor.mockReset();
    mocks.getCredentialScopedUsers.mockResolvedValue([mocks.employee]);
    mocks.getCredentialsFor.mockResolvedValue([
      ...Array.from({ length: 120 }, (_, index) => credential(index + 1, true)),
      ...Array.from({ length: 5 }, (_, index) =>
        credential(index + 121, false),
      ),
    ]);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function request(path: string): Promise<Response> {
    const app = express();
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(`http://127.0.0.1:${address.port}/api${path}`);
  }

  it("filters the scoped result before pagination and returns queue metadata", async () => {
    const response = await request(
      "/credentials?isVerified=false&page=1&pageSize=20",
    );
    const body = (await response.json()) as {
      data: Array<{ isVerified: boolean }>;
      total: number;
      page: number;
      pageSize: number;
    };

    expect(response.status).toBe(200);
    expect(mocks.getCredentialScopedUsers).toHaveBeenCalledWith(mocks.actor);
    expect(mocks.getCredentialsFor).toHaveBeenCalledWith([mocks.employee.id]);
    expect(body).toMatchObject({ total: 5, page: 1, pageSize: 20 });
    expect(body.data).toHaveLength(5);
    expect(
      body.data.every((item: { isVerified: boolean }) => !item.isVerified),
    ).toBe(true);
  });

  it("rejects an invalid boolean before querying scoped credential data", async () => {
    const response = await request("/credentials?isVerified=0");

    expect(response.status).toBe(400);
    expect(mocks.getCredentialScopedUsers).not.toHaveBeenCalled();
    expect(mocks.getCredentialsFor).not.toHaveBeenCalled();
  });
});
