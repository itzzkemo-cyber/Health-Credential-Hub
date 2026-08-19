import { describe, expect, it } from "vitest";
import { readBootstrapAdminConfig } from "./bootstrapAdminConfig";

const base = {
  BOOTSTRAP_CONFIRM: "CREATE_FIRST_ADMIN",
  BOOTSTRAP_ADMIN_EMAIL: "Admin@Example.sa",
  BOOTSTRAP_ADMIN_PASSWORD: "Strong-First-Password-42!",
  BOOTSTRAP_ADMIN_NAME: "Production Admin",
  BOOTSTRAP_ADMIN_NAME_AR: "مسؤول الإنتاج",
  BOOTSTRAP_ADMIN_EMPLOYEE_NUMBER: "ADMIN-001",
  BOOTSTRAP_ADMIN_ROLE: "system_admin",
};

describe("first administrator bootstrap configuration", () => {
  it("requires an explicit confirmation and never has a default password", () => {
    expect(() =>
      readBootstrapAdminConfig({
        ...base,
        BOOTSTRAP_CONFIRM: undefined,
      }),
    ).toThrow(/CREATE_FIRST_ADMIN/);
    expect(() =>
      readBootstrapAdminConfig({
        ...base,
        BOOTSTRAP_ADMIN_PASSWORD: undefined,
      }),
    ).toThrow(/BOOTSTRAP_ADMIN_PASSWORD is required/);
  });

  it("rejects weak passwords and non-admin roles", () => {
    expect(() =>
      readBootstrapAdminConfig({
        ...base,
        BOOTSTRAP_ADMIN_PASSWORD: "password",
        BOOTSTRAP_FACILITY_ID: "1",
      }),
    ).toThrow(/at least 16 characters/);
    expect(() =>
      readBootstrapAdminConfig({
        ...base,
        BOOTSTRAP_ADMIN_ROLE: "employee",
        BOOTSTRAP_FACILITY_ID: "1",
      }),
    ).toThrow(/hospital_admin or system_admin/);
  });

  it("accepts an existing facility only when its id is explicit", () => {
    expect(
      readBootstrapAdminConfig({ ...base, BOOTSTRAP_FACILITY_ID: "17" }),
    ).toMatchObject({
      email: "admin@example.sa",
      facility: { mode: "existing", id: 17 },
      role: "system_admin",
    });
  });

  it("requires a second explicit opt-in to create the first facility", () => {
    expect(
      readBootstrapAdminConfig({
        ...base,
        BOOTSTRAP_CREATE_FACILITY: "CREATE_FACILITY",
        BOOTSTRAP_FACILITY_NAME: "Dammam Hospital",
        BOOTSTRAP_FACILITY_NAME_AR: "مستشفى الدمام",
      }),
    ).toMatchObject({
      facility: {
        mode: "create",
        name: "Dammam Hospital",
        nameAr: "مستشفى الدمام",
      },
    });
    expect(() =>
      readBootstrapAdminConfig({
        ...base,
        BOOTSTRAP_CREATE_FACILITY: "true",
      }),
    ).toThrow(/must equal CREATE_FACILITY/);
  });
});
