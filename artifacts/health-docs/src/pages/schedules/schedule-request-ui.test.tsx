import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type MySchedule,
  type ShiftRequest,
} from "@workspace/api-client-react";
import { LanguageContext, type Language } from "@/lib/language-context";
import { ar } from "@/lib/locales/ar";
import { en } from "@/lib/locales/en";
import SchedulesPage from "./index";
import {
  NewScheduleRequest,
  ScheduleRequestCard,
} from "./schedule-requests";

const state = vi.hoisted(() => ({
  role: "employee",
  userId: 4,
  search: "view=requests",
  mineSpy: vi.fn(),
  reviewSpy: vi.fn(),
  schedulesSpy: vi.fn(),
  mineData: [] as unknown[],
  reviewData: [] as unknown[],
  scheduleData: [] as unknown[],
  mineLoading: false,
  mineError: null as unknown,
  reviewLoading: false,
  reviewError: null as unknown,
}));

vi.mock("@/lib/auth", () => ({
  getAuthUser: () => ({ id: state.userId, role: state.role }),
}));
vi.mock("wouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wouter")>()),
  useSearch: () => state.search,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  const mutation = () => ({
    isPending: false,
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  });
  return {
    ...actual,
    useGetMyScheduleRequests: () => {
      state.mineSpy();
      return {
        data: state.mineData,
        isLoading: state.mineLoading,
        isError: Boolean(state.mineError),
        error: state.mineError,
        refetch: vi.fn(),
      };
    },
    useGetScheduleRequestsForReview: (params: unknown) => {
      state.reviewSpy(params);
      return {
        data: state.reviewData,
        isLoading: state.reviewLoading,
        isError: Boolean(state.reviewError),
        error: state.reviewError,
        refetch: vi.fn(),
      };
    },
    useGetMySchedules: (params: unknown) => {
      state.schedulesSpy(params);
      return {
        data: state.scheduleData,
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    },
    useCreateScheduleRequest: mutation,
    useWithdrawScheduleRequest: mutation,
    useDecideScheduleRequest: mutation,
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const request: ShiftRequest = {
  id: 12,
  employee: { id: 5, name: "Noura Example", nameAr: "نورة المثال" },
  kind: "preferred_shift",
  startDate: "2028-02-04",
  endDate: "2028-02-04",
  shiftCode: "M",
  note: "Short operational note",
  status: "pending",
  version: 3,
  feasibility: {
    status: "possible",
    reasonCodes: [
      "preferred_shift_available",
      "published_schedule_requires_reopen",
    ],
    scheduleId: 2,
    scheduleVersion: 7,
    evaluatedAt: "2028-01-30T10:00:00Z",
  },
  decidedBy: null,
  decidedAt: null,
  createdAt: "2028-01-29T08:00:00Z",
  updatedAt: "2028-01-29T08:00:00Z",
};

const mySchedule: MySchedule = {
  scheduleId: 2,
  title: "February schedule",
  month: "2028-02",
  shiftTypes: [
    {
      code: "M",
      label: "Morning",
      labelAr: "صباحي",
      startTime: "07:00",
      endTime: "15:00",
    },
  ],
  assignments: [],
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
        <Router ssrPath="/schedules?view=requests">{page}</Router>
      </LanguageContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.role = "employee";
  state.userId = 4;
  state.search = "view=requests";
  state.mineData = [];
  state.reviewData = [];
  state.scheduleData = [];
  state.mineLoading = false;
  state.mineError = null;
  state.reviewLoading = false;
  state.reviewError = null;
  vi.clearAllMocks();
});

describe("responsive schedule request UI", () => {
  it.each(["ar", "en"] as const)(
    "renders the employee request journey with %s direction and privacy copy",
    (language) => {
      state.mineData = [request];
      const html = render(<SchedulesPage />, language);
      expect(html).toContain(`dir="${language === "ar" ? "rtl" : "ltr"}"`);
      expect(html).toContain(translate(language, "schedules.requests_title"));
      expect(html).toContain(translate(language, "schedules.request_new"));
      expect(html).toContain(
        translate(language, "schedules.request_privacy_hint"),
      );
      expect(html).toContain(
        translate(language, "schedules.request_feasibility_disclaimer"),
      );
      expect(html).toContain('href="/schedules?view=requests"');
      expect(html).toContain('aria-current="page"');
      expect(html).toContain("grid-cols-3");
      expect(html).toContain("min-h-11");
      expect(html).not.toContain(translate(language, "schedules.request_team"));
      expect(html).not.toContain("<table");
      expect(state.mineSpy).toHaveBeenCalledOnce();
      expect(state.reviewSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ])("shows scoped team review history to the recognized %s role", (role) => {
    state.role = role;
    state.reviewData = [request];
    const html = render(<SchedulesPage />);
    expect(html).toContain("Team requests");
    expect(html).toContain("Noura Example");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).toContain("min-h-11");
    expect(state.reviewSpy).toHaveBeenCalledWith({ status: "pending" });
    expect(state.mineSpy).toHaveBeenCalledOnce();
  });

  it("does not offer a manager an action on their own request", () => {
    state.role = "supervisor";
    state.reviewData = [
      { ...request, employee: { ...request.employee, id: state.userId } },
    ];
    const html = render(<SchedulesPage />);
    expect(html).toContain("Team requests");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Reject<");
  });

  it("lets a manager revoke an approval while retaining other decided history", () => {
    state.role = "department_manager";
    state.reviewData = [{ ...request, status: "approved" }];
    const html = render(<SchedulesPage />);
    expect(html).toContain("Approved");
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Reject<");
    expect(html).toContain("Revoke approval");

    state.reviewData = [{ ...request, status: "rejected" }];
    const rejectedHtml = render(<SchedulesPage />);
    expect(rejectedHtml).not.toContain("Revoke approval");
  });

  it("fails closed for an unknown role before any request hook mounts", () => {
    state.role = "unknown";
    const html = render(<SchedulesPage />);
    expect(html).toContain("Access not permitted");
    expect(state.mineSpy).not.toHaveBeenCalled();
    expect(state.reviewSpy).not.toHaveBeenCalled();
    expect(state.schedulesSpy).not.toHaveBeenCalled();
  });

  it("renders localized loading and empty states without a desktop matrix", () => {
    state.mineLoading = true;
    let html = render(<SchedulesPage />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<table");

    state.mineLoading = false;
    html = render(<SchedulesPage />);
    expect(html).toContain("No requests yet");
    expect(html).toContain("Requests you submit will appear here");
  });

  it("renders safe forbidden and generic query errors without raw server text", () => {
    state.mineError = new ApiError(
      new Response(null, { status: 403 }),
      { code: "forbidden", message: "Private scope detail" },
      { method: "GET", url: "/api/schedule-requests/mine" },
    );
    let html = render(<SchedulesPage />);
    expect(html).toContain("Access not permitted");
    expect(html).not.toContain("Private scope detail");

    state.mineError = new ApiError(
      new Response(null, { status: 500 }),
      { code: "failed", message: "Private database detail" },
      { method: "GET", url: "/api/schedule-requests/mine" },
    );
    html = render(<SchedulesPage />);
    expect(html).toContain("We couldn&#x27;t load this information");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Private database detail");
  });

  it("shows the conditional preferred-shift field and saved shift suggestions", () => {
    state.scheduleData = [mySchedule];
    const html = render(
      <NewScheduleRequest initialKind="preferred_shift" />,
    );
    expect(html).toContain('list="schedule-request-shift-codes"');
    expect(html).toContain('<option value="M"></option>');
    expect(html).toContain('pattern="[A-Z][A-Z0-9_-]{0,7}"');
    expect(html).toContain("Preferred shift code");
    expect(html).not.toContain("End date");
  });

  it.each(["ar", "en"] as const)(
    "explains EO according to facility policy in %s",
    (language) => {
      const html = render(<NewScheduleRequest initialKind="eo" />, language);
      expect(html).toContain(
        translate(language, "schedules.request_kind_eo_hint"),
      );
      expect(html).not.toContain(
        translate(language, "schedules.request_end_date"),
      );
    },
  );

  it.each(["ar", "en"] as const)(
    "renders a bilingual request card and keeps feasibility separate from approval in %s",
    (language) => {
      const html = render(
        <ScheduleRequestCard request={request} showEmployee />,
        language,
      );
      expect(html).toContain(
        language === "ar" ? "نورة المثال" : "Noura Example",
      );
      expect(html).toContain(
        translate(language, "schedules.request_status_pending"),
      );
      expect(html).toContain(
        translate(language, "schedules.request_feasibility_possible"),
      );
      expect(html).toContain(
        translate(language, "schedules.request_feasibility_disclaimer"),
      );
      expect(html).toContain(
        translate(language, "schedules.request_reason_preferred_shift_available"),
      );
      expect(html).not.toContain(
        `>${translate(language, "schedules.request_status_approved")}</div>`,
      );
      expect(html).not.toContain("employeeId");
    },
  );

  it("escapes notes and hides unknown server reason codes behind generic copy", () => {
    const html = render(
      <ScheduleRequestCard
        request={{
          ...request,
          note: "<script>alert(1)</script>",
          feasibility: {
            ...request.feasibility,
            status: "unknown",
            reasonCodes: ["private_server_detail_xyz"],
          },
        }}
      />,
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("A supervisor or manager must review this request.");
    expect(html).not.toContain("private_server_detail_xyz");
  });
});
