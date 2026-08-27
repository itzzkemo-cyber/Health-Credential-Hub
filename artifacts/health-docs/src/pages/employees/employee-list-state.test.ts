import { describe, expect, it } from "vitest";

import {
  buildEmployeeInput,
  buildEmployeeUpdate,
  canEditOrganizationalFields,
  createEmployeeEditForm,
  generateTemporaryPassword,
  getAssignableRoles,
  getComplianceRate,
  getDepartmentOptions,
  getEmployeeDisplayName,
  getEmployeeInitial,
  getSupervisorOptions,
  isPasswordDeliveryReady,
} from "./employee-list-state";

describe("employee list presentation", () => {
  const employee = { name: "Noura Alqahtani", nameAr: "نورة القحطاني" };

  it("uses the correct employee name for Arabic and English", () => {
    expect(getEmployeeDisplayName(employee, true)).toBe("نورة القحطاني");
    expect(getEmployeeDisplayName(employee, false)).toBe("Noura Alqahtani");
  });

  it("falls back safely when the preferred translation is empty", () => {
    expect(getEmployeeDisplayName({ name: "Noura", nameAr: "" }, true)).toBe(
      "Noura",
    );
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
      supervisorId: "8",
      facilityId: "3",
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
      supervisorId: 8,
      facilityId: 3,
      jobTitle: "Nurse",
      jobTitleAr: "ممرضة",
      employeeNumber: "N-204",
    });
  });

  it("omits the facility when the scoped administrator does not select one", () => {
    const payload = buildEmployeeInput({
      name: "Noura",
      nameAr: "نورة",
      email: "noura@hospital.sa",
      password: "manager-entered-secret",
      role: "employee",
      departmentId: "",
      supervisorId: "",
      facilityId: "",
      jobTitle: "Nurse",
      jobTitleAr: "ممرضة",
      employeeNumber: "N-204",
    });

    expect(payload).not.toHaveProperty("facilityId");
    expect(payload.departmentId).toBeNull();
    expect(payload.supervisorId).toBeNull();
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

  it("builds edit payloads without ever attempting a facility move", () => {
    const form = createEmployeeEditForm({
      id: 21,
      name: " Noura ",
      nameAr: " نورة ",
      email: "noura@hospital.sa",
      role: "employee",
      departmentId: 4,
      supervisorId: 8,
      facilityId: 3,
      jobTitle: " Nurse ",
      jobTitleAr: " ممرضة ",
      phone: " 0500000000 ",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const payload = buildEmployeeUpdate(form, true);
    expect(payload).toEqual({
      name: "Noura",
      nameAr: "نورة",
      role: "employee",
      departmentId: 4,
      supervisorId: 8,
      jobTitle: "Nurse",
      jobTitleAr: "ممرضة",
      phone: "0500000000",
    });
    expect(payload).not.toHaveProperty("facilityId");
  });

  it("prevents self organizational edits and respects the admin hierarchy", () => {
    const systemAdmin = { id: 1, role: "system_admin" };
    const hospitalAdmin = { id: 2, role: "hospital_admin" };

    expect(canEditOrganizationalFields(systemAdmin, systemAdmin)).toBe(false);
    expect(
      canEditOrganizationalFields(systemAdmin, {
        id: 9,
        role: "hospital_admin",
      }),
    ).toBe(true);
    expect(
      canEditOrganizationalFields(hospitalAdmin, {
        id: 3,
        role: "hospital_admin",
      }),
    ).toBe(false);
    expect(
      canEditOrganizationalFields(hospitalAdmin, {
        id: 4,
        role: "system_admin",
      }),
    ).toBe(false);
    expect(
      canEditOrganizationalFields(systemAdmin, {
        id: 5,
        role: "system_admin",
      }),
    ).toBe(false);
    expect(getAssignableRoles("system_admin")).toContain("hospital_admin");
    expect(getAssignableRoles("hospital_admin")).not.toContain(
      "hospital_admin",
    );
  });

  it("derives only scoped department and active supervisor options", () => {
    const department = {
      id: 4,
      name: "Nursing",
      nameAr: "التمريض",
      facilityId: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const employees = [
      {
        id: 8,
        name: "Manager",
        nameAr: "مدير",
        email: "manager@hospital.sa",
        role: "department_manager",
        facilityId: 3,
        isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        department,
      },
      {
        id: 9,
        name: "Inactive",
        nameAr: "غير نشط",
        email: "inactive@hospital.sa",
        role: "supervisor",
        facilityId: 3,
        isActive: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    expect(getDepartmentOptions([], employees, 3)).toEqual([
      { id: 4, name: "Nursing", nameAr: "التمريض" },
    ]);
    expect(
      getSupervisorOptions(employees, null, 3).map(({ id }) => id),
    ).toEqual([8]);
  });
});
