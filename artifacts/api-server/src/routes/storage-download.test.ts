import express from "express";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ObjectNotFoundError extends Error {}
  return {
    actor: {
      id: 7,
      role: "employee",
      facilityId: 3,
      departmentId: 11,
      isActive: true,
    },
    linked: [] as Array<{ employeeId: number }>,
    scopedUsers: [] as Array<{
      id: number;
      facilityId: number;
      departmentId: number | null;
    }>,
    hasObjectAcl: false,
    pendingGrant: null as object | null,
    pendingGrantOwnerId: 7,
    findActiveUploadGrant: vi.fn(),
    getObjectEntityFile: vi.fn(),
    downloadObject: vi.fn(),
    logAudit: vi.fn(),
    logError: vi.fn(),
    ObjectNotFoundError,
  };
});

vi.mock("@workspace/db", () => ({
  credentialsTable: { fileUrl: {}, employeeId: {}, deletedAt: {} },
  uploadGrantsTable: {},
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => mocks.linked),
      })),
    })),
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
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
  getCredentialScopedUsers: vi.fn(async () => mocks.scopedUsers),
  logAudit: mocks.logAudit,
}));

vi.mock("../lib/rateLimit", () => ({
  rateLimit: vi.fn(
    () =>
      (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) =>
        next(),
  ),
}));

vi.mock("../lib/safeError", () => ({
  safeErrorLogFields: vi.fn(() => ({ errorName: "Error" })),
}));

vi.mock("../lib/objectAcl", () => ({
  ObjectPermission: { READ: "read" },
}));

vi.mock("../lib/objectStorage", () => ({
  getObjectStorageProvider: vi.fn(() => "filesystem"),
  ObjectNotFoundError: mocks.ObjectNotFoundError,
  ObjectStorageService: class {
    getObjectEntityFile = mocks.getObjectEntityFile;
    canAccessObjectEntity = vi.fn(async () => mocks.hasObjectAcl);
    downloadObject = mocks.downloadObject;
  },
}));

vi.mock("../lib/uploadSecurity", () => ({
  ALLOWED_UPLOAD_CONTENT_TYPE: /^(?:application\/pdf)$/,
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
  UPLOAD_GRANT_TTL_MS: 15 * 60 * 1000,
  findActiveUploadGrant: mocks.findActiveUploadGrant,
  hasAllowedUploadSignature: vi.fn(() => true),
  scanUploadForMalware: vi.fn(),
  MalwareDetectedError: class extends Error {},
  MalwareScanUnavailableError: class extends Error {},
  MalwareScanBusyError: class extends Error {},
  MalwareQuarantineCleanupError: class extends Error {},
}));

import router from "./storage";

describe("private object download authorization", () => {
  const objectPath = "/objects/uploads/credential-document";
  const owner = { id: 41, facilityId: 3, departmentId: 11 };
  let server: ReturnType<express.Express["listen"]> | undefined;
  let origin = "";

  beforeEach(async () => {
    mocks.actor = {
      id: 7,
      role: "employee",
      facilityId: 3,
      departmentId: 11,
      isActive: true,
    };
    mocks.linked = [{ employeeId: owner.id }];
    mocks.scopedUsers = [];
    mocks.hasObjectAcl = false;
    mocks.pendingGrant = null;
    mocks.pendingGrantOwnerId = mocks.actor.id;
    mocks.findActiveUploadGrant.mockReset();
    mocks.findActiveUploadGrant.mockImplementation(
      async (_objectPath: string, requestedBy: number) =>
        requestedBy === mocks.pendingGrantOwnerId ? mocks.pendingGrant : null,
    );
    mocks.getObjectEntityFile.mockReset();
    mocks.getObjectEntityFile.mockResolvedValue({ name: "private object" });
    mocks.downloadObject.mockReset();
    mocks.downloadObject.mockImplementation(async () => {
      const body = Readable.toWeb(
        Readable.from(Buffer.from("private document", "utf8")),
      );
      return new Response(body as ReadableStream, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": "16",
        },
      });
    });
    mocks.logAudit.mockReset();
    mocks.logAudit.mockResolvedValue(undefined);
    mocks.logError.mockReset();

    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, {
        log: { error: mocks.logError, warn: vi.fn() },
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

  function get(): Promise<Response> {
    return fetch(`${origin}/api/storage${objectPath}`);
  }

  it("allows an employee to download only their linked ACL-owned object", async () => {
    mocks.actor = { ...mocks.actor, id: owner.id };
    mocks.hasObjectAcl = true;

    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("private document");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(mocks.logAudit).toHaveBeenCalledOnce();
  });

  it("returns 404 rather than revealing a linked object to another employee", async () => {
    const response = await get();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Object not found",
    });
    expect(mocks.downloadObject).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("allows the requester to read a processed unlinked upload before ACL association", async () => {
    mocks.linked = [];
    mocks.hasObjectAcl = false;
    mocks.pendingGrant = { status: "processed" };

    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("private document");
    expect(mocks.logAudit).toHaveBeenCalledOnce();
    expect(mocks.findActiveUploadGrant).toHaveBeenCalledWith(
      objectPath,
      mocks.actor.id,
    );
  });

  it("hides a processed unlinked upload from a different requester", async () => {
    mocks.linked = [];
    mocks.pendingGrant = { status: "processed" };
    mocks.pendingGrantOwnerId = owner.id;

    const response = await get();

    expect(response.status).toBe(404);
    expect(mocks.downloadObject).not.toHaveBeenCalled();
  });

  it("does not let an upload grant bypass ACL after the object is linked", async () => {
    mocks.hasObjectAcl = false;
    mocks.pendingGrant = { status: "processed" };
    mocks.pendingGrantOwnerId = mocks.actor.id;

    const response = await get();

    expect(response.status).toBe(404);
    expect(mocks.findActiveUploadGrant).not.toHaveBeenCalled();
    expect(mocks.downloadObject).not.toHaveBeenCalled();
  });

  it.each(["supervisor", "department_manager", "hospital_admin"])(
    "allows a %s only when the linked employee is in server-side scope",
    async (role) => {
      mocks.actor = { ...mocks.actor, role };
      mocks.scopedUsers = [owner];

      const response = await get();

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("private document");
      expect(mocks.logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ role }),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        undefined,
        expect.any(String),
        owner.facilityId,
      );
    },
  );

  it.each(["supervisor", "department_manager", "hospital_admin"])(
    "hides a second-facility object from an out-of-scope %s",
    async (role) => {
      mocks.actor = { ...mocks.actor, role };
      mocks.linked = [{ employeeId: 88 }];
      mocks.scopedUsers = [owner];

      const response = await get();

      expect(response.status).toBe(404);
      expect(mocks.downloadObject).not.toHaveBeenCalled();
    },
  );

  it("allows a system admin only when the global scope query returns the owner", async () => {
    mocks.actor = { ...mocks.actor, role: "system_admin", facilityId: 9 };
    mocks.scopedUsers = [{ ...owner, facilityId: 4 }];

    const response = await get();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("private document");
  });

  it.each(["soft-deleted", "unlinked"])(
    "hides a retained %s object even when stale ACL metadata names the caller",
    async () => {
      mocks.actor = { ...mocks.actor, id: owner.id };
      mocks.linked = [];
      mocks.hasObjectAcl = true;

      const response = await get();

      expect(response.status).toBe(404);
      expect(mocks.downloadObject).not.toHaveBeenCalled();
    },
  );

  it("converts storage-level absence to the same 404 envelope", async () => {
    mocks.getObjectEntityFile.mockRejectedValue(
      new mocks.ObjectNotFoundError(),
    );

    const response = await get();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Object not found",
    });
  });

  it("terminates a partial response when the private object stream fails", async () => {
    mocks.actor = { ...mocks.actor, id: owner.id };
    mocks.hasObjectAcl = true;
    mocks.downloadObject.mockImplementation(async () => {
      let emitted = false;
      const failing = new Readable({
        read() {
          if (emitted) return;
          emitted = true;
          this.push(Buffer.from("partial"));
          setImmediate(() => this.destroy(new Error("synthetic stream error")));
        },
      });
      return new Response(Readable.toWeb(failing) as ReadableStream, {
        headers: { "Content-Type": "application/pdf" },
      });
    });

    const response = await get();
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    await vi.waitFor(() => {
      expect(mocks.logError).toHaveBeenCalledWith(
        { errorName: "Error" },
        "Error streaming private object",
      );
    });
  });
});
