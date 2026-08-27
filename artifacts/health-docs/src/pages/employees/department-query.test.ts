import { describe, expect, it } from "vitest";

import { getDepartmentQueryParams } from "./department-query";

describe("getDepartmentQueryParams", () => {
  it("requests departments from the system administrator's selected facility", () => {
    expect(getDepartmentQueryParams("system_admin", 42)).toEqual({
      facilityId: 42,
    });
  });

  it.each(["hospital_admin", "department_manager", "supervisor", "employee"])(
    "does not send a facility selector for %s",
    (role) => {
      expect(getDepartmentQueryParams(role, 42)).toBeUndefined();
    },
  );

  it("waits for a facility selection before scoping a system administrator query", () => {
    expect(getDepartmentQueryParams("system_admin", null)).toBeUndefined();
  });
});
