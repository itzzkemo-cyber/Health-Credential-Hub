import { describe, expect, it } from "vitest";

import {
  DEPARTMENT_PRESETS,
  getDepartmentPresetRows,
  getMissingDepartmentPresets,
  getUniqueDepartmentPresets,
} from "./department-presets";

describe("department presets", () => {
  it("keeps the approved codes in their exact order and copies each code to nameAr", () => {
    expect(DEPARTMENT_PRESETS.map(({ name }) => name)).toEqual([
      "ER",
      "2A",
      "2B",
      "3A",
      "3B",
      "4A",
      "4B",
      "5A",
      "5B",
      "OR",
      "IR",
      "ENDOSCOPY",
    ]);
    expect(
      DEPARTMENT_PRESETS.every(({ name, nameAr }) => name === nameAr),
    ).toBe(true);
  });

  it("deduplicates preset codes before they can be rendered", () => {
    expect(
      getUniqueDepartmentPresets([
        { name: "ER", nameAr: "ER" },
        { name: " er ", nameAr: " er " },
        { name: "2A", nameAr: "2A" },
      ]).map(({ name }) => name),
    ).toEqual(["ER", "2A"]);
  });

  it("calculates only missing departments across either localized name", () => {
    const rows = getDepartmentPresetRows([
      { name: " er ", nameAr: "الطوارئ" },
      { name: "Operating room", nameAr: "or" },
      { name: "2A", nameAr: "2A" },
      { name: "2A", nameAr: "2A" },
    ]);

    expect(
      rows
        .filter(({ isExisting }) => isExisting)
        .map(({ preset }) => preset.name),
    ).toEqual(["ER", "2A", "OR"]);
    expect(
      getMissingDepartmentPresets([{ name: "ER" }, { nameAr: "2A" }]),
    ).toHaveLength(10);
  });

  it("returns no missing entries when every preset already exists", () => {
    expect(
      getMissingDepartmentPresets(
        DEPARTMENT_PRESETS.map(({ name, nameAr }) => ({ name, nameAr })),
      ),
    ).toEqual([]);
  });
});
