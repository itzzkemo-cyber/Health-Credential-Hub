import { useMemo, useState } from "react";
import {
  useGetMySchedules,
  useGetTeamSchedules,
  getGetMySchedulesQueryKey,
  getGetTeamSchedulesQueryKey,
  type MySchedule,
  type TeamSchedule,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorState } from "@/components/QueryErrorState";
import { useIsMobile } from "@/hooks/use-mobile";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import { cellKey, employeeName, monthDates, shiftName } from "./schedule-state";
import { NativeSelect, ScheduleEmpty, ScheduleLoading } from "./schedule-ui";

export function MySchedules({
  month,
  showTeam = false,
}: {
  month: string;
  showTeam?: boolean;
}) {
  return showTeam ? (
    <TeamSchedules month={month} />
  ) : (
    <PersonalSchedules month={month} />
  );
}

function PersonalSchedules({ month }: { month: string }) {
  const query = useGetMySchedules(
    { month },
    {
      query: {
        queryKey: getGetMySchedulesQueryKey({ month }),
        gcTime: 0,
        refetchOnWindowFocus: true,
        refetchInterval: 60_000,
      },
    },
  );
  if (query.isError)
    return (
      <QueryErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  if (query.isLoading) return <ScheduleLoading />;
  if (!query.data?.length) return <ScheduleEmpty employee />;
  return (
    <div className="space-y-5">
      {query.data.map((schedule) => (
        <MyScheduleCard key={schedule.scheduleId} schedule={schedule} />
      ))}
    </div>
  );
}

function TeamSchedules({ month }: { month: string }) {
  // The generated endpoint is server-scoped and returns only published rosters
  // that include the caller. This employee view never mounts the directory or
  // manager-roster queries and receives no contact or organizational fields.
  const query = useGetTeamSchedules(
    { month },
    {
      query: {
        queryKey: getGetTeamSchedulesQueryKey({ month }),
        gcTime: 0,
        refetchOnWindowFocus: true,
        refetchInterval: 60_000,
      },
    },
  );
  const viewerId = (getAuthUser() as { id?: number } | null)?.id;
  if (query.isError)
    return (
      <QueryErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  if (query.isLoading) return <ScheduleLoading />;
  if (!query.data?.length) return <ScheduleEmpty employee team />;
  return (
    <div className="space-y-5">
      {query.data.map((schedule) => (
        <TeamScheduleCard
          key={schedule.scheduleId}
          schedule={schedule}
          viewerId={viewerId}
        />
      ))}
    </div>
  );
}

export function MyScheduleCard({ schedule }: { schedule: MySchedule }) {
  const { t, isRTL } = useLanguage();
  const shifts = new Map(
    schedule.shiftTypes.map((shift) => [shift.code, shift]),
  );
  const assignments = new Map(
    schedule.assignments.map((assignment) => [
      assignment.date,
      assignment.shiftCode,
    ]),
  );
  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="break-words text-xl font-semibold">
              {schedule.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {schedule.assignments.length} {t("schedules.shift_count")} ·
              Asia/Riyadh (UTC+3)
            </p>
          </div>
          <Badge>{t("schedules.published")}</Badge>
        </div>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {monthDates(schedule.month).map((date) => {
            const shift = shifts.get(assignments.get(date) ?? "");
            return (
              <li
                key={date}
                className={`flex min-h-20 items-center gap-3 rounded-lg border p-3 ${shift ? "border-primary/20 bg-primary/5" : "bg-muted/30 text-muted-foreground"}`}
              >
                <DayLabel date={date} isRTL={isRTL} />
                <div className="min-w-0">
                  <ShiftDetails shiftCode={shift?.code} schedule={schedule} />
                  <span className="sr-only">{date}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

export function TeamScheduleCard({
  schedule,
  viewerId,
}: {
  schedule: TeamSchedule;
  viewerId?: number;
}) {
  const { t, isRTL } = useLanguage();
  const mobile = useIsMobile();
  const dates = useMemo(() => monthDates(schedule.month), [schedule.month]);
  const [activeDate, setActiveDate] = useState(dates[0] ?? "");
  const assignmentMap = useMemo(
    () =>
      new Map(
        schedule.assignments.map((assignment) => [
          cellKey(assignment.employeeId, assignment.date),
          assignment.shiftCode,
        ]),
      ),
    [schedule.assignments],
  );
  const displayName = (member: TeamSchedule["participants"][number]) =>
    employeeName(member, isRTL);

  return (
    <Card>
      <CardContent className="space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold">
              {schedule.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {schedule.participants.length} {t("schedules.team_members")} ·
              Asia/Riyadh (UTC+3)
            </p>
          </div>
          <Badge>{t("schedules.published")}</Badge>
        </div>

        <p className="rounded-lg border bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
          {t("schedules.team_visibility_hint")}
        </p>

        <div
          className="flex flex-wrap gap-2"
          aria-label={t("schedules.shifts")}
        >
          {schedule.shiftTypes.map((shift) => (
            <span
              key={shift.code}
              className="rounded-lg border bg-card px-3 py-2 text-sm"
            >
              <strong>{shift.code}</strong> · {shiftName(shift, isRTL)}{" "}
              <bdi className="text-muted-foreground">
                {shift.startTime}–{shift.endTime}
              </bdi>
            </span>
          ))}
          <span className="rounded-lg border border-dashed px-3 py-2 text-sm">
            — {t("schedules.off")}
          </span>
        </div>

        {mobile ? (
          <div className="space-y-4 md:hidden">
            <div>
              <h3 className="font-semibold">{t("schedules.team_day_view")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("schedules.team_day_hint")}
              </p>
            </div>
            <label className="block space-y-1.5 text-sm">
              <span>{t("schedules.day")}</span>
              <NativeSelect
                dir="ltr"
                value={activeDate}
                onChange={(event) => setActiveDate(event.target.value)}
              >
                {dates.map((date) => (
                  <option key={date} value={date}>
                    {date}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <div className="divide-y rounded-lg border px-3">
              {schedule.participants.map((member) => (
                <div
                  key={member.employeeId}
                  className="grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">
                      {displayName(member)}
                    </p>
                    {member.employeeId === viewerId ? (
                      <Badge variant="secondary" className="mt-1">
                        {t("schedules.you")}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="min-w-0 text-sm">
                    <ShiftDetails
                      shiftCode={
                        assignmentMap.get(
                          cellKey(member.employeeId, activeDate),
                        ) ?? ""
                      }
                      schedule={schedule}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="hidden min-w-0 md:block">
            <div>
              <h3 className="font-semibold">{t("schedules.team_matrix")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("schedules.team_matrix_hint")}
              </p>
            </div>
            <div
              role="region"
              aria-label={t("schedules.team_matrix")}
              tabIndex={0}
              className="mt-3 max-w-full overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-max min-w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-muted/60">
                    <th
                      scope="col"
                      className="sticky start-0 z-10 min-w-44 bg-muted p-3 text-start"
                    >
                      {t("schedules.employee")}
                    </th>
                    {dates.map((date) => (
                      <th
                        scope="col"
                        key={date}
                        className="min-w-20 p-2 text-center"
                        aria-label={date}
                      >
                        <DayLabel date={date} isRTL={isRTL} compact />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {schedule.participants.map((member) => (
                    <tr key={member.employeeId} className="border-t">
                      <th
                        scope="row"
                        className="sticky start-0 z-10 max-w-52 bg-card p-3 text-start font-medium"
                      >
                        <span className="block break-words">
                          {displayName(member)}
                        </span>
                        {member.employeeId === viewerId ? (
                          <span className="mt-1 block text-xs text-primary">
                            {t("schedules.you")}
                          </span>
                        ) : null}
                      </th>
                      {dates.map((date) => {
                        const code =
                          assignmentMap.get(cellKey(member.employeeId, date)) ??
                          "";
                        const shift = schedule.shiftTypes.find(
                          (entry) => entry.code === code,
                        );
                        return (
                          <td
                            key={date}
                            className="border-s p-2 text-center"
                            aria-label={`${displayName(member)} · ${date} · ${shift ? shiftName(shift, isRTL) : t("schedules.off")}`}
                          >
                            <span
                              className={
                                code
                                  ? "font-semibold text-foreground"
                                  : "text-muted-foreground"
                              }
                            >
                              {code || "—"}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DayLabel({
  date,
  isRTL,
  compact = false,
}: {
  date: string;
  isRTL: boolean;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "text-center" : "min-w-12 text-center"}>
      <strong className={compact ? "block" : "block text-xl tabular-nums"}>
        {Number(date.slice(-2))}
      </strong>
      <span className="text-xs font-normal text-muted-foreground">
        {new Intl.DateTimeFormat(isRTL ? "ar-SA" : "en-GB", {
          weekday: "short",
          timeZone: "UTC",
        }).format(new Date(`${date}T12:00:00Z`))}
      </span>
    </div>
  );
}

function ShiftDetails({
  shiftCode,
  schedule,
}: {
  shiftCode?: string;
  schedule: Pick<TeamSchedule, "shiftTypes">;
}) {
  const { t, isRTL } = useLanguage();
  const shift = schedule.shiftTypes.find((entry) => entry.code === shiftCode);
  if (!shift)
    return (
      <p className="text-sm text-muted-foreground">{t("schedules.off")}</p>
    );
  return (
    <div className="min-w-0">
      <p className="break-words text-sm font-semibold">
        {shift.code} · {shiftName(shift, isRTL)}
      </p>
      <p className="mt-1 text-sm">
        <bdi>
          {shift.startTime}–{shift.endTime}
        </bdi>
        {shift.endTime < shift.startTime ? (
          <span className="ms-2 text-xs">(+1)</span>
        ) : null}
      </p>
    </div>
  );
}
