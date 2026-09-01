import type {
  CreateEmployeeInvitationInput,
  DepartmentWithStats,
  Employee,
  EmployeeInvitation,
  EmployeeInput,
  EmployeeUpdate,
  EmployeeWithStats,
} from "@workspace/api-client-react";

import type { AdminMfaStepUpCredentials } from "./admin-mfa-step-up";

const TEMPORARY_PASSWORD_LENGTH = 20;
const PASSWORD_CHARACTER_GROUPS = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!@#$%^&*()-_=+",
] as const;
const PASSWORD_ALPHABET = PASSWORD_CHARACTER_GROUPS.join("");
export function getEmployeeDisplayName(
  employee: Pick<EmployeeWithStats, "name" | "nameAr">,
  isRTL: boolean,
): string {
  const preferred = isRTL ? employee.nameAr : employee.name;
  const fallback = isRTL ? employee.name : employee.nameAr;
  return preferred.trim() || fallback.trim();
}

export function getEmployeeInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "•";
}

export function getInvitationDisplayName(
  invitation: Pick<EmployeeInvitation, "name" | "nameAr">,
  isRTL: boolean,
): string {
  const preferred = isRTL ? invitation.nameAr : invitation.name;
  const fallback = isRTL ? invitation.name : invitation.nameAr;
  return preferred.trim() || fallback.trim();
}

export function getInvitationListParams(
  actorRole: string | undefined,
  facilityFilter: string,
): { facilityId: number } | undefined {
  if (actorRole !== "system_admin" || !facilityFilter) return undefined;

  const facilityId = Number(facilityFilter);
  return Number.isInteger(facilityId) && facilityId > 0
    ? { facilityId }
    : undefined;
}

export function getComplianceRate(rate?: number): number {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return 0;
  return Math.min(100, Math.max(0, Math.round(rate)));
}

export function generateTemporaryPassword(): string {
  const characters = PASSWORD_CHARACTER_GROUPS.map(
    (group) => group[secureRandomIndex(group.length)],
  );

  while (characters.length < TEMPORARY_PASSWORD_LENGTH) {
    characters.push(
      PASSWORD_ALPHABET[secureRandomIndex(PASSWORD_ALPHABET.length)],
    );
  }

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomIndex(index + 1);
    [characters[index], characters[swapIndex]] = [
      characters[swapIndex],
      characters[index],
    ];
  }

  return characters.join("");
}

export function isPasswordDeliveryReady(
  password: string,
  acknowledged: boolean,
): boolean {
  return password.length >= 12 && acknowledged;
}

function secureRandomIndex(maxExclusive: number): number {
  const range = 0x1_0000_0000;
  const unbiasedLimit = range - (range % maxExclusive);
  const value = new Uint32Array(1);

  do {
    globalThis.crypto.getRandomValues(value);
  } while (value[0] >= unbiasedLimit);

  return value[0] % maxExclusive;
}

export function buildEmployeeInput(
  form: EmployeeAccountForm,
  stepUp: AdminMfaStepUpCredentials,
): EmployeeInput {
  return {
    name: form.name.trim(),
    nameAr: form.nameAr.trim(),
    email: form.email.trim().toLowerCase(),
    password: form.password,
    role: form.role,
    departmentId: form.departmentId ? Number(form.departmentId) : null,
    supervisorId: form.supervisorId ? Number(form.supervisorId) : null,
    jobTitle: form.jobTitle.trim(),
    jobTitleAr: form.jobTitleAr.trim(),
    employeeNumber: form.employeeNumber.trim(),
    ...(form.phone?.trim() ? { phone: form.phone.trim() } : {}),
    ...(form.facilityId ? { facilityId: Number(form.facilityId) } : {}),
    ...stepUp,
  };
}

export function buildEmployeeInvitationInput(
  form: EmployeeAccountForm,
  stepUp: AdminMfaStepUpCredentials,
): CreateEmployeeInvitationInput {
  const role = getInvitationRole(form.role);

  return {
    name: form.name.trim(),
    nameAr: form.nameAr.trim(),
    email: form.email.trim().toLowerCase(),
    role,
    jobTitle: form.jobTitle.trim(),
    jobTitleAr: form.jobTitleAr.trim(),
    employeeNumber: form.employeeNumber.trim(),
    facilityId: form.facilityId ? Number(form.facilityId) : null,
    departmentId: form.departmentId ? Number(form.departmentId) : null,
    supervisorId: form.supervisorId ? Number(form.supervisorId) : null,
    ...stepUp,
  };
}

function getInvitationRole(
  role: string,
): NonNullable<CreateEmployeeInvitationInput["role"]> {
  if (
    role === "employee" ||
    role === "supervisor" ||
    role === "department_manager" ||
    role === "hospital_admin"
  ) {
    return role;
  }

  throw new Error("Unsupported employee invitation role");
}

export function createEmployeeEditForm(employee: Employee): EmployeeEditForm {
  return {
    name: employee.name,
    nameAr: employee.nameAr,
    role: employee.role,
    departmentId:
      employee.departmentId == null ? "" : String(employee.departmentId),
    supervisorId:
      employee.supervisorId == null ? "" : String(employee.supervisorId),
    jobTitle: employee.jobTitle ?? "",
    jobTitleAr: employee.jobTitleAr ?? "",
    phone: employee.phone ?? "",
  };
}

/** Build only fields supported by EmployeeUpdate; moving facilities is intentionally excluded. */
export function buildEmployeeUpdate(
  form: EmployeeEditForm,
  includeOrganizationalFields: boolean,
  stepUp?: AdminMfaStepUpCredentials,
): EmployeeUpdate {
  return {
    name: form.name.trim(),
    nameAr: form.nameAr.trim(),
    jobTitle: form.jobTitle.trim(),
    jobTitleAr: form.jobTitleAr.trim(),
    phone: form.phone.trim() || null,
    ...(includeOrganizationalFields
      ? {
          role: form.role,
          departmentId: form.departmentId ? Number(form.departmentId) : null,
          supervisorId: form.supervisorId ? Number(form.supervisorId) : null,
        }
      : {}),
    ...(stepUp ?? {}),
  };
}

export function requiresEmployeeCreateStepUp(_role: string): boolean {
  // Every direct provisioning request is a protected administrative action.
  // Returning true for unexpected role values keeps the UI fail-closed while
  // the API remains authoritative for role validation.
  return true;
}

export function hasEmployeeScopeChangesRequiringStepUp(
  employee: Pick<Employee, "departmentId" | "supervisorId">,
  form: Pick<EmployeeEditForm, "departmentId" | "supervisorId">,
): boolean {
  const departmentId =
    employee.departmentId == null ? "" : String(employee.departmentId);
  const supervisorId =
    employee.supervisorId == null ? "" : String(employee.supervisorId);

  return (
    form.departmentId !== departmentId || form.supervisorId !== supervisorId
  );
}

export function canEditOrganizationalFields(
  actor: Pick<Employee, "id" | "role">,
  target: Pick<Employee, "id" | "role">,
): boolean {
  if (actor.id === target.id) return false;
  if (actor.role === "system_admin") return target.role !== "system_admin";
  return (
    actor.role === "hospital_admin" &&
    ["department_manager", "supervisor", "employee"].includes(target.role)
  );
}

export function getAssignableRoles(actorRole: string): string[] {
  if (actorRole === "system_admin") {
    return ["hospital_admin", "department_manager", "supervisor", "employee"];
  }
  if (actorRole === "hospital_admin") {
    return ["department_manager", "supervisor", "employee"];
  }
  return [];
}

export type DepartmentOption = Pick<
  DepartmentWithStats,
  "id" | "name" | "nameAr"
>;

/**
 * The departments endpoint is scoped to the signed-in facility. For a system
 * administrator viewing another facility, preserve the department summaries
 * returned by the scoped employee directory without inventing identifiers.
 */
export function getDepartmentOptions(
  departments: DepartmentWithStats[],
  employees: EmployeeWithStats[],
  facilityId: number | null,
): DepartmentOption[] {
  const byId = new Map<number, DepartmentOption>();

  for (const department of departments) {
    if (facilityId == null || department.facilityId === facilityId) {
      byId.set(department.id, {
        id: department.id,
        name: department.name,
        nameAr: department.nameAr,
      });
    }
  }
  for (const employee of employees) {
    if (employee.facilityId === facilityId && employee.department != null) {
      byId.set(employee.department.id, {
        id: employee.department.id,
        name: employee.department.name,
        nameAr: employee.department.nameAr,
      });
    }
  }

  return [...byId.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function getSupervisorOptions(
  employees: EmployeeWithStats[],
  targetId: number | null,
  facilityId: number | null,
): EmployeeWithStats[] {
  return employees.filter(
    (employee) =>
      employee.id !== targetId &&
      employee.facilityId === facilityId &&
      employee.isActive &&
      employee.role !== "employee",
  );
}

export type EmployeeAccountForm = Pick<
  EmployeeInput,
  | "name"
  | "nameAr"
  | "email"
  | "password"
  | "role"
  | "jobTitle"
  | "jobTitleAr"
  | "employeeNumber"
> & {
  phone?: string;
  departmentId: string;
  supervisorId: string;
  facilityId: string;
};

export type EmployeeEditForm = Pick<
  EmployeeUpdate,
  "name" | "nameAr" | "role" | "jobTitle" | "jobTitleAr" | "phone"
> & {
  name: string;
  nameAr: string;
  role: string;
  jobTitle: string;
  jobTitleAr: string;
  phone: string;
  departmentId: string;
  supervisorId: string;
};
