import { useState } from "react";
import { Link, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetScheduleQueryKey,
  getListSchedulesQueryKey,
  useListSchedules,
  type Schedule,
} from "@workspace/api-client-react";
import { ArrowLeft, CalendarDays, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorState } from "@/components/QueryErrorState";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";
import { canManageSchedules, currentMonth } from "./schedule-state";
import { MonthPicker, ScheduleEmpty, ScheduleLoading } from "./schedule-ui";
import { MySchedules } from "./my-schedules";
import { ScheduleCreate } from "./schedule-create";
import { ScheduleEditor } from "./schedule-editor";
import { ScheduleRequests } from "./schedule-requests";

export default function SchedulesPage() {
  const { t, isRTL } = useLanguage();
  const [month, setMonth] = useState(currentMonth);
  const search = useSearch();
  const role = (getAuthUser() as { role?: string } | null)?.role;
  const manager = canManageSchedules(role);
  const employee = role === "employee";
  const requestedView = new URLSearchParams(search).get("view");
  const activeView =
    requestedView === "mine" || requestedView === "requests"
      ? requestedView
      : "primary";
  const personalView = activeView === "mine";
  const requestsView = activeView === "requests";
  const employeeTeamView = employee && activeView === "primary";
  if (!manager && role !== "employee")
    return (
      <div role="alert" className="rounded-lg border border-destructive/30 p-6">
        {t("common.forbidden_title")}
      </div>
    );
  return (
    <section className="min-w-0 space-y-6" dir={isRTL ? "rtl" : "ltr"}>
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-primary/10 p-2.5 text-primary">
            <CalendarDays className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 className="text-2xl font-bold">
            {t(
              requestsView
                ? "schedules.requests_title"
                : employeeTeamView
                ? "schedules.team_title"
                : personalView
                  ? "schedules.my_title"
                  : "schedules.title",
            )}
          </h1>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {t(
            requestsView
              ? "schedules.requests_subtitle"
              : employeeTeamView
              ? "schedules.team_subtitle"
              : personalView
                ? "schedules.my_subtitle"
                : "schedules.subtitle",
          )}
        </p>
      </header>
      {manager || employee ? (
        <nav
          aria-label={t("schedules.view_label")}
          className="grid grid-cols-3 gap-2 rounded-xl border bg-card p-1.5 sm:max-w-xl"
        >
          {(manager
            ? [
                {
                  view: "primary",
                  href: "/schedules",
                  label: "schedules.manage_view",
                },
                {
                  view: "mine",
                  href: "/schedules?view=mine",
                  label: "schedules.my_title",
                },
                {
                  view: "requests",
                  href: "/schedules?view=requests",
                  label: "schedules.requests_view",
                },
              ]
            : [
                {
                  view: "primary",
                  href: "/schedules",
                  label: "schedules.team_title",
                },
                {
                  view: "mine",
                  href: "/schedules?view=mine",
                  label: "schedules.my_title",
                },
                {
                  view: "requests",
                  href: "/schedules?view=requests",
                  label: "schedules.requests_view",
                },
              ]
          ).map((view) => (
            <Link
              key={view.href}
              href={view.href}
              aria-current={activeView === view.view ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center justify-center rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeView === view.view
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(view.label)}
            </Link>
          ))}
        </nav>
      ) : null}
      {requestsView ? (
        <ScheduleRequests manager={manager} />
      ) : manager && !personalView ? (
        <ManagedSchedules month={month} setMonth={setMonth} />
      ) : (
        <>
          <MonthPicker month={month} onChange={setMonth} />
          <MySchedules month={month} showTeam={employeeTeamView} />
        </>
      )}
    </section>
  );
}

function ManagedSchedules({
  month,
  setMonth,
}: {
  month: string;
  setMonth: (month: string) => void;
}) {
  const { t, isRTL } = useLanguage();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"list" | "create" | number>("list");
  const query = useListSchedules(
    { month },
    {
      query: {
        queryKey: getListSchedulesQueryKey({ month }),
        enabled: view === "list",
        gcTime: 0,
      },
    },
  );
  function created(schedule: Schedule) {
    queryClient.setQueryData(getGetScheduleQueryKey(schedule.id), schedule);
    void queryClient.invalidateQueries({
      queryKey: getListSchedulesQueryKey({ month }),
    });
    setView(schedule.id);
  }
  if (typeof view === "number")
    return <ScheduleEditor id={view} onBack={() => setView("list")} />;
  if (view === "create")
    return (
      <div className="space-y-4">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 gap-2"
          onClick={() => setView("list")}
        >
          <ArrowLeft
            className={`h-4 w-4 ${isRTL ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
          {t("schedules.back")}
        </Button>
        <MonthPicker month={month} onChange={setMonth} disabled />
        <ScheduleCreate key={month} month={month} onCreated={created} />
      </div>
    );
  return (
    <div className="space-y-5">
      <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-end">
        <MonthPicker month={month} onChange={setMonth} />
        <Button
          type="button"
          className="min-h-11 gap-2"
          onClick={() => setView("create")}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("schedules.new_schedule")}
        </Button>
      </div>
      {query.isError ? (
        <QueryErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.isLoading ? (
        <ScheduleLoading />
      ) : !query.data?.length ? (
        <ScheduleEmpty />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {query.data.map((schedule) => (
            <Card key={schedule.id}>
              <CardContent className="space-y-4 p-4 sm:p-5">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="min-w-0 break-words text-lg font-semibold">
                    {schedule.title}
                  </h2>
                  <Badge
                    variant={
                      schedule.status === "published" ? "default" : "secondary"
                    }
                  >
                    {t(`schedules.${schedule.status}`)}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                  <span>
                    {schedule.employeeCount} {t("schedules.employees")}
                  </span>
                  <span
                    className={
                      schedule.shortageCount
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-primary"
                    }
                  >
                    {schedule.shortageCount
                      ? `${schedule.shortageCount} ${t("schedules.shortages")}`
                      : t("schedules.no_shortages")}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 w-full"
                  onClick={() => setView(schedule.id)}
                >
                  {t("schedules.open")}
                  <span className="sr-only">: {schedule.title}</span>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
