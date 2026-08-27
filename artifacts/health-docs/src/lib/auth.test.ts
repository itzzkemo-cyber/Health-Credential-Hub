import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MemoryStorage = Storage & {
  writes: Array<[string, string]>;
};

function createMemoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  const writes: Array<[string, string]> = [];

  return {
    get length() {
      return values.size;
    },
    writes,
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      writes.push([key, value]);
      values.set(key, value);
    },
  };
}

const user = {
  id: 17,
  email: "employee@example.invalid",
  name: "Example Employee",
  nameAr: "موظف تجريبي",
  role: "employee" as const,
  departmentId: 3,
  supervisorId: 8,
  facilityId: 2,
  isActive: true,
  mustChangePassword: false,
  totpEnabled: true,
  createdAt: "2026-08-27T00:00:00.000Z",
};

describe("in-memory authentication session", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    vi.resetModules();
    storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes profile and token values left by older browser builds", async () => {
    storage.setItem("healthdocs_auth_user", JSON.stringify(user));
    storage.setItem("healthdocs_auth_token", "legacy-token");

    await import("./auth");

    expect(storage.getItem("healthdocs_auth_user")).toBeNull();
    expect(storage.getItem("healthdocs_auth_token")).toBeNull();
  });

  it("keeps the current user in page memory without writing browser storage", async () => {
    const auth = await import("./auth");
    storage.writes.length = 0;

    auth.setAuthSession(user);

    expect(auth.getAuthUser()).toEqual(user);
    expect(auth.isAuthenticated()).toBe(true);
    expect(storage.writes).toEqual([]);
    expect(storage.getItem(auth.USER_KEY)).toBeNull();
  });

  it("does not restore an identity after an application reload", async () => {
    const firstBoot = await import("./auth");
    firstBoot.setAuthSession(user);

    vi.resetModules();
    const nextBoot = await import("./auth");

    expect(nextBoot.getAuthUser()).toBeNull();
    expect(nextBoot.isAuthenticated()).toBe(false);
  });

  it("clears both page memory and historical browser values on logout", async () => {
    const auth = await import("./auth");
    auth.setAuthSession(user);
    storage.setItem(auth.USER_KEY, JSON.stringify(user));
    storage.setItem("healthdocs_auth_token", "legacy-token");

    auth.clearAuthSession();

    expect(auth.getAuthUser()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
    expect(storage.getItem(auth.USER_KEY)).toBeNull();
    expect(storage.getItem("healthdocs_auth_token")).toBeNull();
  });
});
