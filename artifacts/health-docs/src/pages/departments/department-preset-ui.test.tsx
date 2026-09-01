import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageContext, type Language } from "@/lib/language-context";
import { ar } from "@/lib/locales/ar";
import { en } from "@/lib/locales/en";
import Departments, { DepartmentPresetList } from "./index";
import { getDepartmentPresetRows } from "./department-presets";

const state = vi.hoisted(() => ({
  role: "hospital_admin",
  departments: [] as Array<{
    id: number;
    name: string;
    nameAr: string;
    employeeCount: number;
    complianceRate: number;
    expiredCount: number;
    expiringCount: number;
  }>,
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: () => ({ id: 1, role: state.role }),
}));

vi.mock("@workspace/api-client-react", () => ({
  getListDepartmentsQueryKey: () => ["/api/departments"],
  useListDepartments: () => ({ data: state.departments, isLoading: false }),
  useBatchCreateDepartments: () => ({ isPending: false, mutate: vi.fn() }),
  useCreateDepartment: () => ({ isPending: false, mutate: vi.fn() }),
  useUpdateDepartment: () => ({ isPending: false, mutate: vi.fn() }),
  useDeleteDepartment: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function translate(language: Language, key: string): string {
  let current: unknown = language === "ar" ? ar : en;
  for (const segment of key.split(".")) {
    current =
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined;
  }
  return typeof current === "string" ? current : key;
}

function render(page: React.ReactElement, language: Language = "en") {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <LanguageContext.Provider
        value={{
          language,
          setLanguage: vi.fn(),
          t: (key) => translate(language, key),
          isRTL: language === "ar",
        }}
      >
        {page}
      </LanguageContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.role = "hospital_admin";
  state.departments = [];
});

describe("department preset UI", () => {
  it.each([
    ["ar", "rtl"],
    ["en", "ltr"],
  ] as const)(
    "shows one localized batch action to an administrator in %s",
    (language, direction) => {
      const html = render(<Departments />, language);
      const label = translate(language, "departments.preset_add");

      expect(html).toContain(`dir="${direction}"`);
      expect(html.match(new RegExp(label, "g"))).toHaveLength(1);
      expect(html).toContain("min-h-11");
    },
  );

  it("does not expose the batch action to a non-administrator", () => {
    state.role = "employee";
    const html = render(<Departments />);

    expect(html).not.toContain(translate("en", "departments.preset_add"));
  });

  it("renders each preset code once and marks existing codes", () => {
    const rows = getDepartmentPresetRows(
      [{ name: "ER" }],
      [
        { name: "ER", nameAr: "ER" },
        { name: "er", nameAr: "er" },
        { name: "2A", nameAr: "2A" },
      ],
    );
    const html = render(
      <DepartmentPresetList
        rows={rows}
        listLabel="Preset department codes"
        existingLabel="Added"
      />,
    );

    expect(html.match(/>ER<\/code>/g)).toHaveLength(1);
    expect(html.match(/>2A<\/code>/g)).toHaveLength(1);
    expect(html.match(/>Added<\/div>/g)).toHaveLength(1);
  });

  it("keeps every preset message available in Arabic and English", () => {
    const keys = [
      "departments.preset_add",
      "departments.preset_title",
      "departments.preset_description",
      "departments.preset_missing_count",
      "departments.preset_codes_label",
      "departments.preset_existing",
      "departments.preset_confirm",
      "departments.preset_adding",
      "departments.preset_created_count",
      "departments.preset_skipped_count",
      "departments.preset_all_existing",
      "departments.preset_error",
    ];

    for (const language of ["ar", "en"] as const) {
      for (const key of keys) {
        const value = translate(language, key);
        expect(value).not.toBe(key);
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
