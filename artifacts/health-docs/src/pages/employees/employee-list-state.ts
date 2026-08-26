import type {
  EmployeeInput,
  EmployeeWithStats,
} from "@workspace/api-client-react";

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

export function getComplianceRate(rate?: number): number {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return 0;
  return Math.min(100, Math.max(0, Math.round(rate)));
}

export function generateTemporaryPassword(): string {
  const characters = PASSWORD_CHARACTER_GROUPS.map((group) =>
    group[secureRandomIndex(group.length)],
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
): EmployeeInput {
  return {
    name: form.name.trim(),
    nameAr: form.nameAr.trim(),
    email: form.email.trim().toLowerCase(),
    password: form.password,
    role: form.role,
    departmentId: form.departmentId ? Number(form.departmentId) : null,
    jobTitle: form.jobTitle.trim(),
    jobTitleAr: form.jobTitleAr.trim(),
    employeeNumber: form.employeeNumber.trim(),
  };
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
  departmentId: string;
};
