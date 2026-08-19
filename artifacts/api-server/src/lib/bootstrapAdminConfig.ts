import type { UserRole } from "@workspace/db/schema";

export class BootstrapAdminConfigError extends Error {}

export interface BootstrapAdminConfig {
  email: string;
  password: string;
  name: string;
  nameAr: string;
  employeeNumber: string;
  facility:
    | { mode: "existing"; id: number }
    | { mode: "create"; name: string; nameAr: string };
  role: Extract<UserRole, "hospital_admin" | "system_admin">;
}

export function readBootstrapAdminConfig(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapAdminConfig {
  if (env.BOOTSTRAP_CONFIRM !== "CREATE_FIRST_ADMIN") {
    throw new BootstrapAdminConfigError(
      "BOOTSTRAP_CONFIRM must equal CREATE_FIRST_ADMIN for this non-interactive operation",
    );
  }
  const required = [
    "BOOTSTRAP_ADMIN_EMAIL",
    "BOOTSTRAP_ADMIN_PASSWORD",
    "BOOTSTRAP_ADMIN_NAME",
    "BOOTSTRAP_ADMIN_NAME_AR",
    "BOOTSTRAP_ADMIN_EMPLOYEE_NUMBER",
    "BOOTSTRAP_ADMIN_ROLE",
  ] as const;
  for (const name of required) {
    if (!env[name]?.trim()) {
      throw new BootstrapAdminConfigError(`${name} is required`);
    }
  }
  const email = env.BOOTSTRAP_ADMIN_EMAIL!.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BootstrapAdminConfigError(
      "BOOTSTRAP_ADMIN_EMAIL must be a valid email address",
    );
  }
  const password = env.BOOTSTRAP_ADMIN_PASSWORD!;
  if (
    password.length < 16 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/\d/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new BootstrapAdminConfigError(
      "BOOTSTRAP_ADMIN_PASSWORD must be at least 16 characters with upper, lower, number, and symbol",
    );
  }
  let facility: BootstrapAdminConfig["facility"];
  if (env.BOOTSTRAP_CREATE_FACILITY === "CREATE_FACILITY") {
    const name = env.BOOTSTRAP_FACILITY_NAME?.trim();
    const nameAr = env.BOOTSTRAP_FACILITY_NAME_AR?.trim();
    if (!name || !nameAr) {
      throw new BootstrapAdminConfigError(
        "Facility creation requires BOOTSTRAP_FACILITY_NAME and BOOTSTRAP_FACILITY_NAME_AR",
      );
    }
    if (env.BOOTSTRAP_FACILITY_ID?.trim()) {
      throw new BootstrapAdminConfigError(
        "Choose either BOOTSTRAP_FACILITY_ID or explicit facility creation, not both",
      );
    }
    facility = { mode: "create", name, nameAr };
  } else {
    if (env.BOOTSTRAP_CREATE_FACILITY?.trim()) {
      throw new BootstrapAdminConfigError(
        "BOOTSTRAP_CREATE_FACILITY must equal CREATE_FACILITY when used",
      );
    }
    const facilityId = Number(env.BOOTSTRAP_FACILITY_ID);
    if (!Number.isSafeInteger(facilityId) || facilityId < 1) {
      throw new BootstrapAdminConfigError(
        "BOOTSTRAP_FACILITY_ID must be a positive integer, or explicitly create a facility",
      );
    }
    facility = { mode: "existing", id: facilityId };
  }
  const role = env.BOOTSTRAP_ADMIN_ROLE;
  if (role !== "hospital_admin" && role !== "system_admin") {
    throw new BootstrapAdminConfigError(
      "BOOTSTRAP_ADMIN_ROLE must be hospital_admin or system_admin",
    );
  }
  return {
    email,
    password,
    name: env.BOOTSTRAP_ADMIN_NAME!.trim(),
    nameAr: env.BOOTSTRAP_ADMIN_NAME_AR!.trim(),
    employeeNumber: env.BOOTSTRAP_ADMIN_EMPLOYEE_NUMBER!.trim(),
    facility,
    role,
  };
}
