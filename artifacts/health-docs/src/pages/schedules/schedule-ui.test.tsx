import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MySchedule,
  Schedule,
  TeamSchedule,
} from "@workspace/api-client-react";
import { LanguageContext, type Language } from "@/lib/language-context";
import { ar } from "@/lib/locales/ar";
import { en } from "@/lib/locales/en";
import { schedulesAr, schedulesEn } from "@/lib/locales/schedules";
import SchedulesPage from "./index";
import { ScheduleCreate } from "./schedule-create";
import { ScheduleDraftEditor } from "./schedule-editor";
import { MyScheduleCard, TeamScheduleCard } from "./my-schedules";

const state = vi.hoisted(() => ({
  role: "employee",
  userId: 4,
  mobile: false,
  search: "",
  employees: vi.fn(),
  managed: vi.fn(),
  mine: vi.fn(),
  team: vi.fn(),
  employeeData: [] as unknown[],
  mineData: [] as unknown[],
  teamData: [] as unknown[],
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: () => ({ id: state.userId, role: state.role }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }));
vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wouter")>()),
  useSearch: () => state.search,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  const query = { isLoading: false, isError: false, refetch: vi.fn() };
  const mutation = () => ({
    isPending: false,
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  });
  return {
    ...actual,
    useListEmployees: (params: unknown) => {
      state.employees(params);
      return { ...query, data: state.employeeData };
    },
    useListSchedules: () => {
      state.managed();
      return { ...query, data: [] };
    },
    useGetMySchedules: () => {
      state.mine();
      return { ...query, data: state.mineData };
    },
    useGetTeamSchedules: () => {
      state.team();
      return { ...query, data: state.teamData };
    },
    useCreateSchedule: mutation,
    useUpdateSchedule: mutation,
    usePublishSchedule: mutation,
    useReopenSchedule: mutation,
    useCancelSchedule: mutation,
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const schedule: Schedule = {
  id: 1,
  title: "Test team schedule",
  month: "2028-02",
  status: "draft",
  version: 3,
  employeeCount: 1,
  shortageCount: 28,
  createdAt: "2028-01-01T00:00:00Z",
  updatedAt: "2028-01-01T00:00:00Z",
  facilityId: 2,
  employeeIds: [4],
  shiftTypes: [
    {
      code: "M",
      label: "Morning",
      labelAr: "صباحي",
      startTime: "07:00",
      endTime: "15:00",
      requiredPerDay: 1,
    },
  ],
  constraints: {
    minRestHours: 11,
    maxConsecutiveDays: 5,
    maxShiftsPerMonth: 22,
  },
  unavailability: [{ employeeId: 4, date: "2028-02-02" }],
  assignments: [{ employeeId: 4, date: "2028-02-01", shiftCode: "M" }],
  issues: [],
  shortages: [{ date: "2028-02-02", shiftCode: "M", required: 1, assigned: 0 }],
  warnings: ["planning_assistance_only", "boundary_review_required"],
};

const mySchedule: MySchedule = {
  scheduleId: 1,
  title: "Test team schedule",
  month: "2028-02",
  shiftTypes: schedule.shiftTypes,
  assignments: schedule.assignments,
};

const teamSchedule: TeamSchedule = {
  ...mySchedule,
  participants: [
    { employeeId: 4, name: "Noura Example", nameAr: "نورة المثال" },
    { employeeId: 5, name: "Omar Example", nameAr: "عمر المثال" },
  ],
  assignments: [
    { employeeId: 4, date: "2028-02-01", shiftCode: "M" },
    { employeeId: 5, date: "2028-02-02", shiftCode: "M" },
  ],
};

function translate(language: Language, key: string): string {
  let current: unknown = language === "ar" ? ar : en;
  for (const segment of key.split("."))
    current =
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined;
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
        <Router ssrPath="/schedules">{page}</Router>
      </LanguageContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.role = "employee";
  state.userId = 4;
  state.mobile = false;
  state.search = "";
  state.employeeData = [];
  state.mineData = [];
  state.teamData = [];
  vi.clearAllMocks();
});

describe("responsive schedule UI", () => {
  it.each(["ar", "en"] as const)(
    "keeps %s employee team view read-only without querying management data",
    (language) => {
      const html = render(<SchedulesPage />, language);
      expect(html).toContain(`dir="${language === "ar" ? "rtl" : "ltr"}"`);
      expect(html).toContain(translate(language, "schedules.team_title"));
      expect(html).toContain(translate(language, "schedules.my_title"));
      expect(html).toContain(translate(language, "schedules.team_empty"));
      expect(html).not.toContain(translate(language, "schedules.new_schedule"));
      expect(state.team).toHaveBeenCalledOnce();
      expect(state.mine).not.toHaveBeenCalled();
      expect(state.employees).not.toHaveBeenCalled();
      expect(state.managed).not.toHaveBeenCalled();
    },
  );
  it.each([
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ])("shows management controls only to recognized %s role", (role) => {
    state.role = role;
    const html = render(<SchedulesPage />);
    expect(html).toContain("Create schedule");
    expect(state.managed).toHaveBeenCalledOnce();
    expect(state.mine).not.toHaveBeenCalled();
    expect(state.team).not.toHaveBeenCalled();
  });
  it.each([
    ["supervisor", "ar"],
    ["supervisor", "en"],
    ["department_manager", "ar"],
    ["department_manager", "en"],
    ["hospital_admin", "ar"],
    ["hospital_admin", "en"],
    ["system_admin", "ar"],
    ["system_admin", "en"],
  ] as const)(
    "keeps %s personal view scoped and localized in %s until management is selected",
    (role, language) => {
      state.role = role;
      state.search = "view=mine";
      const html = render(<SchedulesPage />, language);
      expect(html).toContain(
        `aria-label="${translate(language, "schedules.view_label")}"`,
      );
      expect(html).toContain(translate(language, "schedules.manage_view"));
      expect(html).toContain(translate(language, "schedules.my_title"));
      expect(html).toContain('href="/schedules?view=mine"');
      expect(html).toContain('aria-current="page"');
      expect(html).toContain(translate(language, "schedules.my_empty"));
      expect(html).not.toContain(translate(language, "schedules.new_schedule"));
      expect(state.mine).toHaveBeenCalledOnce();
      expect(state.managed).not.toHaveBeenCalled();
      expect(state.team).not.toHaveBeenCalled();
      expect(state.employees).not.toHaveBeenCalled();
      state.search = "";
      state.mine.mockClear();
      const managementHtml = render(<SchedulesPage />, language);
      expect(managementHtml).toContain(
        translate(language, "schedules.new_schedule"),
      );
      expect(state.managed).toHaveBeenCalledOnce();
      expect(state.mine).not.toHaveBeenCalled();
      expect(state.team).not.toHaveBeenCalled();
      expect(state.employees).not.toHaveBeenCalled();
    },
  );
  it("lets an employee switch from the team roster to personal shifts", () => {
    const teamHtml = render(<SchedulesPage />);
    expect(teamHtml).toContain("Team schedule");
    expect(teamHtml).toContain('href="/schedules?view=mine"');
    expect(teamHtml).not.toContain("Manage rosters");
    expect(state.team).toHaveBeenCalledOnce();
    expect(state.mine).not.toHaveBeenCalled();

    state.search = "view=mine";
    state.team.mockClear();
    const mineHtml = render(<SchedulesPage />);
    expect(mineHtml).toContain("My shifts");
    expect(mineHtml).toContain("No published shifts for this month");
    expect(mineHtml).not.toContain("Create schedule");
    expect(state.mine).toHaveBeenCalledOnce();
    expect(state.team).not.toHaveBeenCalled();
    expect(state.managed).not.toHaveBeenCalled();
    expect(state.employees).not.toHaveBeenCalled();
  });
  it("fails closed for unknown roles without any schedule query", () => {
    state.role = "unknown";
    const html = render(<SchedulesPage />);
    expect(html).toContain("Access not permitted");
    expect(state.managed).not.toHaveBeenCalled();
    expect(state.mine).not.toHaveBeenCalled();
    expect(state.team).not.toHaveBeenCalled();
    expect(state.employees).not.toHaveBeenCalled();
  });
  it.each(["ar", "en"] as const)(
    "renders labeled bilingual shift setup with no upload or reason fields in %s",
    (language) => {
      const html = render(
        <ScheduleCreate month="2028-02" onCreated={vi.fn()} />,
        language,
      );
      expect(state.employees).toHaveBeenCalledWith({ isActive: true });
      expect(html).toContain('type="search"');
      expect(html.match(/type="time"/g)).toHaveLength(6);
      expect(html).toContain(
        translate(language, "schedules.availability_hint"),
      );
      expect(html).toContain(translate(language, "schedules.planning_notice"));
      expect(html).not.toContain('type="file"');
      expect(html).not.toContain("localStorage");
      expect(html).toContain('disabled=""');
    },
  );
  it("offers active management accounts as shift participants", () => {
    state.employeeData = [
      {
        id: 4,
        name: "Example manager",
        nameAr: "مدير تجريبي",
        role: "supervisor",
        isActive: true,
        facilityId: 2,
      },
      {
        id: 5,
        name: "Inactive account",
        nameAr: "حساب غير نشط",
        role: "employee",
        isActive: false,
        facilityId: 2,
      },
    ];
    const html = render(<ScheduleCreate month="2028-02" onCreated={vi.fn()} />);
    expect(html).toContain("Example manager");
    expect(html).not.toContain("Inactive account");
  });
  it("contains desktop horizontal scrolling and labeled assignment controls", () => {
    const html = render(
      <ScheduleDraftEditor
        initialSchedule={schedule}
        onBack={vi.fn()}
        onReload={async () => {}}
      />,
    );
    expect(html).toContain('role="region"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain('scope="row"');
    expect(html).toContain("Employee ID 4 · 2028-02-01 · Shift assignment");
    expect(html).toContain(
      "Employee ID 4 · 2028-02-02 · Shift assignment: Unavailable",
    );
    expect(html).toContain("Cancel draft");
  });
  it.each(["ar", "en"] as const)(
    "uses a compact day editor without a full matrix on mobile in %s",
    (language) => {
      state.mobile = true;
      const html = render(
        <ScheduleDraftEditor
          initialSchedule={schedule}
          onBack={vi.fn()}
          onReload={async () => {}}
        />,
        language,
      );
      expect(html).not.toContain("<table");
      expect(html).toContain(translate(language, "schedules.edit_day"));
      expect(html).toContain("min-h-11");
      expect(html).toContain("minmax(0,1fr)");
      expect(html).toContain(translate(language, "schedules.publish_hint"));
    },
  );
  it("does not render editable assignment selects for a published schedule", () => {
    state.mobile = true;
    const html = render(
      <ScheduleDraftEditor
        initialSchedule={{ ...schedule, status: "published" }}
        onBack={vi.fn()}
        onReload={async () => {}}
      />,
    );
    expect(html).not.toContain("data-employee-id");
    expect(html).not.toContain("Save changes");
    expect(html).toContain("Withdraw publication");
  });

  it.each(["ar", "en"] as const)(
    "shows saved planning issues and the roster capacity explanation beside actions in %s",
    (language) => {
      const constrained: Schedule = {
        ...schedule,
        month: "2026-09",
        employeeIds: [4, 5, 6],
        employeeCount: 3,
        shiftTypes: [
          { ...schedule.shiftTypes[0], code: "M" },
          { ...schedule.shiftTypes[0], code: "A" },
          { ...schedule.shiftTypes[0], code: "N" },
        ],
        issues: ["monthly_shift_limit", "consecutive_day_limit"],
        shortages: [],
        shortageCount: 0,
      };
      const html = render(
        <ScheduleDraftEditor
          initialSchedule={constrained}
          onBack={vi.fn()}
          onReload={async () => {}}
        />,
        language,
      );
      expect(html).toContain(translate(language, "schedules.capacity_title"));
      expect(html).toContain(
        translate(language, "schedules.draft_saved_blocked"),
      );
      expect(html).toContain("90");
      expect(html).toContain("66");
      expect(html).toContain("5");
      expect(html).toContain(
        translate(language, "schedules.issue_monthly_shift_limit"),
      );
    },
  );

  it("does not offer mutations for retained cancelled history", () => {
    const html = render(
      <ScheduleDraftEditor
        initialSchedule={{ ...schedule, status: "cancelled" }}
        onBack={vi.fn()}
        onReload={async () => {}}
      />,
    );
    expect(html).toContain("Cancelled");
    expect(html).not.toContain("data-employee-id");
    expect(html).not.toContain("Withdraw publication");
    expect(html).not.toContain("Cancel draft");
  });
  it.each(["ar", "en"] as const)(
    "shows only own returned shifts, dates and off days in %s",
    (language) => {
      const html = render(<MyScheduleCard schedule={mySchedule} />, language);
      expect(html).toContain(translate(language, "schedules.off"));
      expect(html).toContain(translate(language, "schedules.published"));
      expect(html).toContain("07:00–15:00");
      expect(html).not.toContain("<select");
      expect(html).not.toContain("employeeId");
      expect(html).not.toContain(translate(language, "schedules.unavailable"));
    },
  );
  it.each(["ar", "en"] as const)(
    "shows the scoped published team roster read-only on a phone in %s",
    (language) => {
      state.mobile = true;
      const html = render(
        <TeamScheduleCard schedule={teamSchedule} viewerId={4} />,
        language,
      );
      expect(html).not.toContain("<table");
      expect(html).toContain(
        language === "ar" ? "نورة المثال" : "Noura Example",
      );
      expect(html).toContain(language === "ar" ? "عمر المثال" : "Omar Example");
      expect(html).toContain(translate(language, "schedules.you"));
      expect(html).toContain(translate(language, "schedules.team_day_view"));
      expect(html).toContain("minmax(0,1fr)");
      expect(html).not.toContain("data-employee-id");
      expect(html).not.toContain(translate(language, "schedules.save"));
      expect(html).not.toContain(translate(language, "schedules.unavailable"));
    },
  );
  it("contains the published team roster in an internally scrolling desktop table", () => {
    const html = render(
      <TeamScheduleCard schedule={teamSchedule} viewerId={4} />,
    );
    expect(html).toContain("Published team roster");
    expect(html).toContain('role="region"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain('scope="row"');
    expect(html).toContain("Noura Example");
    expect(html).toContain("Omar Example");
    expect(html).not.toContain("Save changes");
  });
  it("renders employee team results from the dedicated scoped hook", () => {
    state.mobile = true;
    state.teamData = [teamSchedule];
    const html = render(<SchedulesPage />);
    expect(html).toContain("Noura Example");
    expect(html).toContain("Omar Example");
    expect(state.team).toHaveBeenCalledOnce();
    expect(state.mine).not.toHaveBeenCalled();
    expect(state.managed).not.toHaveBeenCalled();
    expect(state.employees).not.toHaveBeenCalled();
  });
  it("keeps every roster message translated in Arabic and English", () => {
    expect(Object.keys(schedulesAr).sort()).toEqual(
      Object.keys(schedulesEn).sort(),
    );
    for (const dictionary of [schedulesAr, schedulesEn])
      for (const value of Object.values(dictionary))
        expect(value.trim().length).toBeGreaterThan(0);
  });
});
