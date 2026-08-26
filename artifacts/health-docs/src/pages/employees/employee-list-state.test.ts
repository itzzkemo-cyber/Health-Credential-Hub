import { describe, expect, it } from "vitest";

import {
  buildEmployeeInput,
  generateTemporaryPassword,
  getComplianceRate,
  getEmployeeDisplayName,
  getEmployeeInitial,
  isPasswordDeliveryReady,
} from "./employee-list-state";

describe("employee list presentation", () => {
  const employee = { name: "Noura Alqahtani", nameAr: "نورة القحطاني" };

  it("uses the correct employee name for Arabic and English", () => {
    expect(getEmployeeDisplayName(employee, true)).toBe("نورة القحطاني");
    expect(getEmployeeDisplayName(employee, false)).toBe("Noura Alqahtani");
  });

  it("falls back safely when the preferred translation is empty", () => {
    expect(
      getEmployeeDisplayName({ name: "Noura", nameAr: "" }, true),
    ).toBe("Noura");
    expect(getEmployeeInitial("")).toBe("•");
  });

  it("normalizes malformed compliance values for progress display", () => {
    expect(getComplianceRate(undefined)).toBe(0);
    expect(getComplianceRate(-10)).toBe(0);
    expect(getComplianceRate(84.6)).toBe(85);
    expect(getComplianceRate(120)).toBe(100);
  });

  it("builds the scoped API payload without adding a facility or generated password", () => {
    const payload = buildEmployeeInput({
      name: "  Noura Alqahtani ",
      nameAr: " نورة القحطاني ",
      email: " Noura@Hospital.SA ",
      password: "manager-entered-secret",
      role: "employee",
      departmentId: "4",
      jobTitle: " Nurse ",
      jobTitleAr: " ممرضة ",
      employeeNumber: " N-204 ",
    });

    expect(payload).toEqual({
      name: "Noura Alqahtani",
      nameAr: "نورة القحطاني",
      email: "noura@hospital.sa",
      password: "manager-entered-secret",
      role: "employee",
      departmentId: 4,
      jobTitle: "Nurse",
      jobTitleAr: "ممرضة",
      employeeNumber: "N-204",
    });
    expect(payload).not.toHaveProperty("facilityId");
  });

  it("generates a strong temporary password without a fixed value", () => {
    const password = generateTemporaryPassword();

    expect(password).toHaveLength(20);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[!@#$%^&*()\-_=+]/);
  });

  it("blocks account creation until temporary-password delivery is acknowledged", () => {
    expect(isPasswordDeliveryReady("StrongTemporary123!", false)).toBe(false);
    expect(isPasswordDeliveryReady("short", true)).toBe(false);
    expect(isPasswordDeliveryReady("StrongTemporary123!", true)).toBe(true);
  });
});
