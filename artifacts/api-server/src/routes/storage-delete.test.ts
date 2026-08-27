import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  class ObjectNotFoundError extends Error {}
  return {
    actor: {
      id: 7,
      email: "employee@example.test",
      passwordHash: "unused",
      name: "Employee",
      nameAr: "موظف",
      role: "employee",
      departmentId: 11,
      supervisorId: null,
      facilityId: 3,
      jobTitle: "Nurse",
      jobTitleAr: "ممرض",
      employeeNumber: "E-7",
      phone: null,
      avatarUrl: null,
      googleId: null,
      isActive: true,
      mustChangePassword: false,
      sessionVersion: 2,
      totpSecret: null,
      totpEnabled: false,
      backupCodes: null,
      totpLastUsedStep: null,
      notificationPrefs: [],
      createdAt: new Date("2026-08-27T00:00:00.000Z"),
    },
    freshSession: true,
    grant: null as null | {
      id: number;
      objectPath: string;
      requestedBy: number;
      status: "pending" | "processing" | "processed";
      expiresAt: Date;
      claimedAt: Date | null;
    },
    linked: [] as Array<{ id: number; deletedAt?: Date | null }>,
    deletedGrant: false,
    audit: null as Record<string, unknown> | null,
    getObjectEntityFile: vi.fn(),
    deleteObject: vi.fn(),
    logError: vi.fn(),
    ObjectNotFoundError,
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  isNull: vi.fn((column: unknown) => ({ column, isNull: true })),
}));

vi.mock("@workspace/db", () => {
  const usersTable = { id: "users.id" };
  const uploadGrantsTable = {
    id: "uploadGrants.id",
    objectPath: "uploadGrants.objectPath",
    requestedBy: "uploadGrants.requestedBy",
  };
  const credentialsTable = {
    id: "credentials.id",
    fileUrl: "credentials.fileUrl",
    employeeId: "credentials.employeeId",
    deletedAt: "credentials.deletedAt",
  };
  const auditLogsTable = { kind: "auditLogs" };

  function selection(rows: unknown[]) {
    const query = {
      where: vi.fn(() => query),
      for: vi.fn(async () => rows),
      limit: vi.fn(async () => rows),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  }

  const db = {
    transaction: vi.fn(
      async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          select: vi.fn(() => ({
            from: vi.fn((table: unknown) => {
              if (table === usersTable) return selection([state.actor]);
              if (table === uploadGrantsTable) {
                const owned =
                  state.grant && state.grant.requestedBy === state.actor.id
                    ? [state.grant]
                    : [];
                return selection(owned);
              }
              if (table === credentialsTable) return selection(state.linked);
              return selection([]);
            }),
          })),
          delete: vi.fn((table: unknown) => ({
            where: vi.fn(async () => {
              if (table === uploadGrantsTable) state.deletedGrant = true;
            }),
          })),
          insert: vi.fn((table: unknown) => ({
            values: vi.fn(async (values: Record<string, unknown>) => {
              if (table === auditLogsTable) state.audit = values;
            }),
          })),
        };
        return callback(tx);
      },
    ),
    // Other storage handlers are not invoked by this focused suite.
    select: vi.fn(),
    insert: vi.fn(),
  };

  return {
    auditLogsTable,
    credentialsTable,
    db,
    uploadGrantsTable,
    usersTable,
  };
});

vi.mock("../lib/auth", () => ({
  MANAGER_ROLES: [
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ],
  getUser: vi.fn(() => state.actor),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../lib/helpers", () => ({
  getCredentialScopedUsers: vi.fn(async () => []),
  logAudit: vi.fn(),
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit: vi.fn(
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
  ),
}));

vi.mock("../lib/safeError", () => ({
  safeErrorLogFields: vi.fn(() => ({ errorName: "Error" })),
}));

vi.mock("../lib/sessionFreshness", () => ({
  isFreshActiveSessionActor: vi.fn(() => state.freshSession),
}));

vi.mock("../lib/objectAcl", () => ({
  ObjectPermission: { READ: "read" },
}));

vi.mock("../lib/objectStorage", () => ({
  getObjectStorageProvider: vi.fn(() => "filesystem"),
  ObjectNotFoundError: state.ObjectNotFoundError,
  ObjectStorageService: class {
    getObjectEntityFile = state.getObjectEntityFile;
    deleteObject = state.deleteObject;
  },
}));

vi.mock("../lib/uploadSecurity", () => ({
  ALLOWED_UPLOAD_CONTENT_TYPE: /^(?:application\/pdf)$/,
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  UPLOAD_GRANT_TTL_MS: 15 * 60 * 1000,
  findActiveUploadGrant: vi.fn(),
  hasAllowedUploadSignature: vi.fn(() => true),
  scanUploadForMalware: vi.fn(),
  MalwareDetectedError: class extends Error {},
  MalwareScanUnavailableError: class extends Error {},
  MalwareScanBusyError: class extends Error {},
  MalwareQuarantineCleanupError: class extends Error {},
}));

import router from "./storage";

describe("unlinked private upload deletion", () => {
  const uploadId = "f3fddc5a-9315-4b7b-8e7c-8ac98bc9f6c5";
  const objectPath = `/objects/uploads/${uploadId}`;
  let server: ReturnType<express.Express["listen"]> | undefined;
  let origin = "";

  beforeEach(async () => {
    state.actor = {
      ...state.actor,
      id: 7,
      role: "employee",
      facilityId: 3,
      isActive: true,
      sessionVersion: 2,
    };
    state.freshSession = true;
    state.grant = {
      id: 91,
      objectPath,
      requestedBy: state.actor.id,
      status: "pending",
      // Cleanup remains available after the short-lived link capability ends.
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      claimedAt: null,
    };
    state.linked = [];
    state.deletedGrant = false;
    state.audit = null;
    state.getObjectEntityFile.mockReset();
    state.getObjectEntityFile.mockResolvedValue({ name: "private upload" });
    state.deleteObject.mockReset();
    state.deleteObject.mockResolvedValue(undefined);
    state.logError.mockReset();

    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, {
        log: { error: state.logError, warn: vi.fn() },
      });
      next();
    });
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  });

  function remove(id = uploadId): Promise<globalThis.Response> {
    return fetch(`${origin}/api/storage/uploads/${id}`, { method: "DELETE" });
  }

  it("deletes an expired, unclaimed upload owned by the caller", async () => {
    const response = await remove();

    expect(response.status).toBe(204);
    expect(state.getObjectEntityFile).toHaveBeenCalledWith(objectPath);
    expect(state.deleteObject).toHaveBeenCalledOnce();
    expect(state.deletedGrant).toBe(true);
    expect(state.audit).toEqual(
      expect.objectContaining({
        userId: 7,
        facilityId: 3,
        action: "Deleted unlinked private upload",
        details: null,
      }),
    );
    expect(JSON.stringify(state.audit)).not.toContain(uploadId);
  });

  it("does not delete a grant or object while the sanitizer owns it", async () => {
    state.grant = { ...state.grant!, status: "processing" };

    const response = await remove();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Upload not found",
    });
    expect(state.getObjectEntityFile).not.toHaveBeenCalled();
    expect(state.deleteObject).not.toHaveBeenCalled();
    expect(state.deletedGrant).toBe(false);
    expect(state.audit).toBeNull();
  });

  it("continues to recognize the owner after a facility reassignment", async () => {
    state.actor = { ...state.actor, facilityId: 9 };

    const response = await remove();

    expect(response.status).toBe(204);
    expect(state.audit).toEqual(expect.objectContaining({ facilityId: 9 }));
  });

  it.each([
    ["same-facility manager", "hospital_admin", 3],
    ["cross-facility manager", "hospital_admin", 8],
    ["global system administrator", "system_admin", 9],
  ])(
    "returns the same 404 to a non-owner %s",
    async (_label, role, facilityId) => {
      state.actor = { ...state.actor, id: 99, role, facilityId };

      const response = await remove();

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "Upload not found",
      });
      expect(state.getObjectEntityFile).not.toHaveBeenCalled();
      expect(state.deleteObject).not.toHaveBeenCalled();
      expect(state.deletedGrant).toBe(false);
    },
  );

  it.each(["active", "soft-deleted"])(
    "retains an upload linked by an %s credential row",
    async (kind) => {
      state.linked = [
        {
          id: 44,
          deletedAt:
            kind === "soft-deleted"
              ? new Date("2026-08-01T00:00:00.000Z")
              : null,
        },
      ];

      const response = await remove();

      expect(response.status).toBe(404);
      expect(state.getObjectEntityFile).not.toHaveBeenCalled();
      expect(state.deleteObject).not.toHaveBeenCalled();
      expect(state.deletedGrant).toBe(false);
    },
  );

  it("uses the same 404 for invalid identifiers and storage absence", async () => {
    expect((await remove("not-a-valid-upload-id")).status).toBe(404);

    state.getObjectEntityFile.mockRejectedValue(
      new state.ObjectNotFoundError(),
    );
    const missing = await remove();
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: "Upload not found",
    });
    expect(state.deletedGrant).toBe(false);
  });

  it("rejects a stale or deactivated session before storage access", async () => {
    state.freshSession = false;

    const response = await remove();

    expect(response.status).toBe(401);
    expect(state.getObjectEntityFile).not.toHaveBeenCalled();
    expect(state.deleteObject).not.toHaveBeenCalled();
  });

  it("fails closed without deleting the grant when provider deletion fails", async () => {
    state.deleteObject.mockRejectedValue(new Error("provider unavailable"));

    const response = await remove();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to delete unlinked upload",
    });
    expect(state.deletedGrant).toBe(false);
    expect(state.audit).toBeNull();
    expect(state.logError).toHaveBeenCalledWith(
      { errorName: "Error" },
      "Error deleting unlinked private upload",
    );
  });
});
