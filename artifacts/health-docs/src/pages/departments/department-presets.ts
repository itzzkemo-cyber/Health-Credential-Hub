export interface DepartmentPreset {
  name: string;
  nameAr: string;
}

export interface ExistingDepartmentName {
  name?: string | null;
  nameAr?: string | null;
}

export interface DepartmentPresetRow {
  preset: DepartmentPreset;
  isExisting: boolean;
}

const RAW_DEPARTMENT_PRESETS: readonly DepartmentPreset[] = [
  { name: "ER", nameAr: "ER" },
  { name: "2A", nameAr: "2A" },
  { name: "2B", nameAr: "2B" },
  { name: "3A", nameAr: "3A" },
  { name: "3B", nameAr: "3B" },
  { name: "4A", nameAr: "4A" },
  { name: "4B", nameAr: "4B" },
  { name: "5A", nameAr: "5A" },
  { name: "5B", nameAr: "5B" },
  { name: "OR", nameAr: "OR" },
  { name: "IR", nameAr: "IR" },
  { name: "ENDOSCOPY", nameAr: "ENDOSCOPY" },
];

function normalizeDepartmentName(value: string): string {
  return value.trim().toLocaleUpperCase("en-US");
}

/**
 * Keeps a preset code visible only once, even if a future preset source
 * accidentally contains repeated values or different casing.
 */
export function getUniqueDepartmentPresets(
  presets: readonly DepartmentPreset[],
): DepartmentPreset[] {
  const seen = new Set<string>();

  return presets.filter((preset) => {
    const code = normalizeDepartmentName(preset.name);
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

export const DEPARTMENT_PRESETS = Object.freeze(
  getUniqueDepartmentPresets(RAW_DEPARTMENT_PRESETS),
);

export function getDepartmentPresetRows(
  departments: readonly ExistingDepartmentName[] | null | undefined,
  presets: readonly DepartmentPreset[] = DEPARTMENT_PRESETS,
): DepartmentPresetRow[] {
  const existingNames = new Set<string>();

  for (const department of departments ?? []) {
    if (department.name) {
      existingNames.add(normalizeDepartmentName(department.name));
    }
    if (department.nameAr) {
      existingNames.add(normalizeDepartmentName(department.nameAr));
    }
  }

  return getUniqueDepartmentPresets(presets).map((preset) => ({
    preset,
    isExisting:
      existingNames.has(normalizeDepartmentName(preset.name)) ||
      existingNames.has(normalizeDepartmentName(preset.nameAr)),
  }));
}

export function getMissingDepartmentPresets(
  departments: readonly ExistingDepartmentName[] | null | undefined,
): DepartmentPreset[] {
  return getDepartmentPresetRows(departments)
    .filter((row) => !row.isExisting)
    .map((row) => row.preset);
}
