import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMySchedulesQueryKey,
  getGetScheduleQueryKey,
  getListSchedulesQueryKey,
  useGetSchedule,
  useListEmployees,
  usePublishSchedule,
  useReopenSchedule,
  useUpdateSchedule,
  useCancelSchedule,
  type Schedule,
  type ShiftAssignment,
  type ShiftType,
} from "@workspace/api-client-react";
import { ArrowLeft, Check, Save, Send, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { QueryErrorState } from "@/components/QueryErrorState";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLanguage } from "@/lib/language-context";
import {
  assignmentSignature,
  canPublish,
  cellKey,
  coveragePreview,
  employeeName,
  monthDates,
  replaceAssignment,
  rosterCapacity,
  scheduleErrorKey,
  scheduleIssueKey,
  shiftName,
} from "./schedule-state";
import { NativeSelect, ScheduleLoading } from "./schedule-ui";

type Confirmation = "publish" | "reopen" | "cancel" | "discard" | "reload";

export function ScheduleEditor({
  id,
  onBack,
}: {
  id: number;
  onBack: () => void;
}) {
  const query = useGetSchedule(id, {
    query: {
      queryKey: getGetScheduleQueryKey(id),
      gcTime: 0,
      refetchOnWindowFocus: false,
    },
  });
  const [reloadKey, setReloadKey] = useState(0);
  if (query.isError)
    return (
      <QueryErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  if (!query.data || query.isLoading) return <ScheduleLoading />;
  // Background cache updates never replace a manager's unsaved work.
  return (
    <ScheduleDraftEditor
      key={`${id}:${reloadKey}`}
      initialSchedule={query.data}
      onBack={onBack}
      onReload={async () => {
        const latest = await query.refetch();
        if (latest.isSuccess) setReloadKey((key) => key + 1);
      }}
    />
  );
}

export function ScheduleDraftEditor({
  initialSchedule,
  onBack,
  onReload,
}: {
  initialSchedule: Schedule;
  onBack: () => void;
  onReload: () => Promise<void>;
}) {
  const { t, isRTL } = useLanguage();
  const queryClient = useQueryClient();
  const mobile = useIsMobile();
  const [schedule, setSchedule] = useState(initialSchedule);
  const [assignments, setAssignments] = useState<ShiftAssignment[]>(
    initialSchedule.assignments,
  );
  const [activeDate, setActiveDate] = useState(`${initialSchedule.month}-01`);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [leavingHref, setLeavingHref] = useState<string | null>(null);
  const navigationApproved = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const employeesQuery = useListEmployees({ facilityId: schedule.facilityId });
  const update = useUpdateSchedule({ mutation: { gcTime: 0 } });
  const publish = usePublishSchedule({ mutation: { gcTime: 0 } });
  const reopen = useReopenSchedule({ mutation: { gcTime: 0 } });
  const cancel = useCancelSchedule({ mutation: { gcTime: 0 } });
  const pending =
    update.isPending ||
    publish.isPending ||
    reopen.isPending ||
    cancel.isPending;
  const dirty =
    assignmentSignature(schedule.assignments) !==
    assignmentSignature(assignments);
  const conflict = errorKey === "conflict";
  const editable = schedule.status === "draft" && !pending && !conflict;
  const dates = useMemo(() => monthDates(schedule.month), [schedule.month]);
  const employeeMap = useMemo(
    () =>
      new Map(
        (employeesQuery.data ?? []).map((employee) => [employee.id, employee]),
      ),
    [employeesQuery.data],
  );
  const assignmentMap = useMemo(
    () =>
      new Map(
        assignments.map((entry) => [
          cellKey(entry.employeeId, entry.date),
          entry.shiftCode,
        ]),
      ),
    [assignments],
  );
  const unavailableKeys = useMemo(
    () =>
      new Set(
        schedule.unavailability.map((entry) =>
          cellKey(entry.employeeId, entry.date),
        ),
      ),
    [schedule.unavailability],
  );
  const counts = useMemo(() => {
    const map = new Map<number, number>();
    for (const entry of assignments)
      map.set(entry.employeeId, (map.get(entry.employeeId) ?? 0) + 1);
    return map;
  }, [assignments]);
  const coverage = useMemo(
    () => coveragePreview(schedule.month, schedule.shiftTypes, assignments),
    [schedule.month, schedule.shiftTypes, assignments],
  );
  const shortageCount = coverage.reduce(
    (sum, entry) => sum + Math.max(0, entry.required - entry.assigned),
    0,
  );
  const capacity = useMemo(() => rosterCapacity(schedule), [schedule]);
  const capacityShortfall = capacity.available < capacity.required;
  const displayName = (id: number) => {
    const employee = employeeMap.get(id);
    return employee
      ? employeeName(employee, isRTL)
      : `${t("schedules.employee_fallback")} ${id}`;
  };

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (navigationApproved.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeNavigate = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        !anchor ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setLeavingHref(anchor.href);
      setConfirmation("discard");
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeNavigate, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeNavigate, true);
    };
  }, [dirty]);

  async function run(operation: "save" | "publish" | "reopen" | "cancel") {
    if (pending) return;
    setErrorKey(null);
    try {
      const request = {
        id: schedule.id,
        data: { expectedVersion: schedule.version },
      };
      if (operation === "cancel") {
        await cancel.mutateAsync(request);
        await queryClient.invalidateQueries({
          queryKey: getListSchedulesQueryKey({ month: schedule.month }),
        });
        onBack();
        return;
      }
      const result =
        operation === "save"
          ? await update.mutateAsync({
              ...request,
              data: { ...request.data, assignments },
            })
          : operation === "publish"
            ? await publish.mutateAsync(request)
            : await reopen.mutateAsync(request);
      setSchedule(result);
      setAssignments(result.assignments);
      queryClient.setQueryData(getGetScheduleQueryKey(result.id), result);
      void queryClient.invalidateQueries({
        queryKey: getListSchedulesQueryKey({ month: result.month }),
      });
      void queryClient.invalidateQueries({
        queryKey: getGetMySchedulesQueryKey({ month: result.month }),
      });
      toast.success(
        t(
          `schedules.${operation === "save" ? "saved" : operation === "publish" ? "published_success" : "reopened_success"}`,
        ),
      );
    } catch (error) {
      setErrorKey(scheduleErrorKey(error));
    }
  }

  const changeAssignment = useCallback(
    (employeeId: number, date: string, shiftCode: string) => {
      setAssignments((previous) =>
        replaceAssignment(previous, employeeId, date, shiftCode),
      );
    },
    [],
  );

  function cell(employeeId: number, date: string, compact: boolean) {
    return (
      <AssignmentCell
        employeeId={employeeId}
        date={date}
        name={displayName(employeeId)}
        value={assignmentMap.get(cellKey(employeeId, date)) ?? ""}
        blocked={unavailableKeys.has(cellKey(employeeId, date))}
        editable={editable}
        compact={compact}
        shiftTypes={schedule.shiftTypes}
        onChange={changeAssignment}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-5" dir={isRTL ? "rtl" : "ltr"}>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 gap-2"
        disabled={pending}
        onClick={() => (dirty ? setConfirmation("discard") : onBack())}
      >
        <ArrowLeft
          className={`h-4 w-4 ${isRTL ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
        {t("schedules.back")}
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <Badge
              variant={
                schedule.status === "published" ? "default" : "secondary"
              }
            >
              {t(`schedules.${schedule.status}`)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {t("schedules.version")} {schedule.version}
            </span>
          </div>
          <h2
            ref={titleRef}
            tabIndex={-1}
            className="break-words text-2xl font-bold focus:outline-none"
          >
            {schedule.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            <bdi>{schedule.month}</bdi> · {schedule.employeeIds.length}{" "}
            {t("schedules.employees")}
          </p>
        </div>
        <span className="inline-flex items-center gap-2 text-sm" role="status">
          {dirty ? (
            <span className="h-2 w-2 rounded-full bg-amber-500" />
          ) : (
            <Check className="h-4 w-4 text-primary" aria-hidden="true" />
          )}
          {t(dirty ? "schedules.unsaved" : "schedules.saved_state")}
        </span>
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        <p>{t("schedules.planning_notice")}</p>
        <p className="mt-2">{t("schedules.boundary_notice")}</p>
      </div>
      {employeesQuery.isError ? (
        <QueryErrorState
          compact
          error={employeesQuery.error}
          onRetry={() => {
            void employeesQuery.refetch();
          }}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
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
        <span className="rounded-lg bg-muted px-3 py-2 text-sm">
          × {t("schedules.unavailable")}
        </span>
      </div>
      {!mobile ? (
        <Card className="hidden min-w-0 overflow-hidden md:block">
          <CardContent className="p-0">
            <div className="p-4">
              <h3 className="font-semibold">{t("schedules.matrix")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("schedules.matrix_hint")}
              </p>
            </div>
            <div
              role="region"
              aria-label={t("schedules.matrix")}
              tabIndex={0}
              className="max-w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-max min-w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-muted/60">
                    <th
                      scope="col"
                      className="sticky start-0 z-10 min-w-40 bg-muted p-3 text-start"
                    >
                      {t("schedules.employee")}
                    </th>
                    {dates.map((date) => (
                      <th
                        scope="col"
                        key={date}
                        className="min-w-24 p-2"
                        aria-label={date}
                      >
                        <span className="block font-semibold">
                          {Number(date.slice(-2))}
                        </span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {new Intl.DateTimeFormat(isRTL ? "ar-SA" : "en-GB", {
                            weekday: "short",
                            timeZone: "UTC",
                          }).format(new Date(`${date}T12:00:00Z`))}
                        </span>
                      </th>
                    ))}
                    <th scope="col" className="p-3">
                      {t("schedules.total")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.employeeIds.map((employeeId) => (
                    <tr key={employeeId} className="border-t">
                      <th
                        scope="row"
                        className="sticky start-0 z-10 max-w-52 bg-card p-3 text-start font-medium"
                      >
                        <span className="block break-words">
                          {displayName(employeeId)}
                        </span>
                      </th>
                      {dates.map((date) => (
                        <td key={date} className="border-s p-1">
                          {cell(employeeId, date, true)}
                        </td>
                      ))}
                      <td className="p-3 text-center font-semibold">
                        {counts.get(employeeId) ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
      <Card className="md:hidden">
        <CardContent className="space-y-4 p-4">
          <h3 className="font-semibold">{t("schedules.edit_day")}</h3>
          <label className="block space-y-1.5 text-sm">
            <span>{t("schedules.day")}</span>
            <NativeSelect
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
          <div className="divide-y">
            {schedule.employeeIds.map((employeeId) => (
              <div
                key={employeeId}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">
                    {displayName(employeeId)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {counts.get(employeeId) ?? 0} {t("schedules.shift_count")}
                  </p>
                </div>
                {cell(employeeId, activeDate, false)}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t("schedules.coverage")}</h3>
            <Badge variant={shortageCount ? "destructive" : "secondary"}>
              {shortageCount
                ? `${shortageCount} ${t("schedules.unfilled")}`
                : t("schedules.no_shortages")}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("schedules.assigned_required")}
          </p>
          <div className="max-h-60 overflow-y-auto space-y-2">
            {(mobile
              ? coverage.filter((entry) => entry.date === activeDate)
              : coverage.filter((entry) => entry.assigned < entry.required)
            ).map((entry) => (
              <div
                key={`${entry.date}:${entry.shiftCode}`}
                className="flex flex-wrap justify-between gap-2 rounded-md bg-muted/50 p-2 text-sm"
              >
                <span>
                  <bdi>{entry.date}</bdi> · {entry.shiftCode}
                </span>
                <span
                  className={
                    entry.assigned < entry.required
                      ? "font-semibold text-destructive"
                      : "text-primary"
                  }
                >
                  {entry.assigned} / {entry.required}
                </span>
              </div>
            ))}
          </div>
          {shortageCount ? (
            <p className="text-sm text-amber-800 dark:text-amber-200">
              {t("schedules.coverage_notice")}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <div className="space-y-3 rounded-lg border bg-card p-4">
        {capacityShortfall ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            <p className="font-semibold">{t("schedules.capacity_title")}</p>
            <p className="mt-1">
              {t("schedules.capacity_detail")
                .replace("{required}", String(capacity.required))
                .replace("{employees}", String(schedule.employeeIds.length))
                .replace("{limit}", String(schedule.constraints.maxShiftsPerMonth))
                .replace("{available}", String(capacity.available))
                .replace("{minimum}", String(capacity.minimumEmployees))}
            </p>
          </div>
        ) : null}
        {!dirty && schedule.status === "draft" && schedule.issues.length ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          >
            <p className="font-semibold">{t("schedules.draft_saved_blocked")}</p>
            <p className="mt-1">{t("schedules.draft_saved_blocked_hint")}</p>
            <ul className="mt-2 list-inside list-disc space-y-1">
              {[...new Set(schedule.issues)].map((issue) => (
                <li key={issue}>{t(`schedules.${scheduleIssueKey(issue)}`)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {errorKey ? (
          <div
            role="alert"
            className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <p>{t(`schedules.${errorKey}`)}</p>
            {conflict ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setConfirmation("reload")}
              >
                {t("schedules.reload")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {t(
            schedule.status === "published"
              ? "schedules.published_hint"
              : "schedules.constraints_notice",
          )}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {schedule.status === "draft" ? (
            <>
              <Button
                type="button"
                className="min-h-11 gap-2"
                disabled={!dirty || !editable}
                onClick={() => {
                  void run("save");
                }}
              >
                <Save className="h-4 w-4" aria-hidden="true" />
                {t(update.isPending ? "schedules.saving" : "schedules.save")}
              </Button>
              <Button
                type="button"
                className="min-h-11 gap-2"
                variant="outline"
                disabled={!canPublish(schedule, assignments, pending, conflict)}
                onClick={() => setConfirmation("publish")}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                {t("schedules.publish")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 text-destructive sm:ms-auto"
                disabled={pending || conflict}
                onClick={() => setConfirmation("cancel")}
              >
                {t("schedules.cancel_draft")}
              </Button>
            </>
          ) : schedule.status === "published" ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2"
              disabled={pending || conflict}
              onClick={() => setConfirmation("reopen")}
            >
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              {t("schedules.reopen")}
            </Button>
          ) : null}
        </div>
        {schedule.status === "draft" ? (
          <p className="text-xs text-muted-foreground">
            {t("schedules.publish_hint")}
          </p>
        ) : null}
      </div>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmation(null);
            setLeavingHref(null);
          }
        }}
      >
        <AlertDialogContent
          dir={isRTL ? "rtl" : "ltr"}
          className="max-w-[calc(100%-2rem)] sm:max-w-lg"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                `schedules.${confirmation === "publish" ? "publish_title" : confirmation === "reopen" ? "reopen_title" : confirmation === "cancel" ? "cancel_title" : "discard_title"}`,
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                `schedules.${confirmation === "publish" ? "publish_confirmation" : confirmation === "reopen" ? "reopen_hint" : confirmation === "cancel" ? "cancel_hint" : confirmation === "reload" ? "conflict" : "discard_hint"}`,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
              onClick={() => {
                if (confirmation === "discard") {
                  navigationApproved.current = true;
                  if (leavingHref) window.location.assign(leavingHref);
                  else onBack();
                } else if (confirmation === "reload") void onReload();
                else if (confirmation) void run(confirmation);
              }}
            >
              {t(
                `schedules.${confirmation === "publish" ? "publish" : confirmation === "reopen" ? "reopen_confirm" : confirmation === "cancel" ? "cancel_draft" : confirmation === "reload" ? "reload" : "discard"}`,
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const AssignmentCell = memo(function AssignmentCell({
  employeeId,
  date,
  name,
  value,
  blocked,
  editable,
  compact,
  shiftTypes,
  onChange,
}: {
  employeeId: number;
  date: string;
  name: string;
  value: string;
  blocked: boolean;
  editable: boolean;
  compact: boolean;
  shiftTypes: ShiftType[];
  onChange: (employeeId: number, date: string, code: string) => void;
}) {
  const { t, isRTL } = useLanguage();
  const label = `${name} · ${date} · ${t("schedules.assignment")}`;
  if (blocked)
    return (
      <span
        aria-label={`${label}: ${t("schedules.unavailable")}`}
        className="flex min-h-11 items-center justify-center rounded-md bg-muted px-2 text-xs text-muted-foreground"
      >
        ×{" "}
        <span className={compact ? "sr-only" : undefined}>
          {t("schedules.unavailable")}
        </span>
      </span>
    );
  if (!editable) {
    const shift = shiftTypes.find((item) => item.code === value);
    return (
      <span
        aria-label={label}
        className="flex min-h-11 items-center justify-center rounded-md bg-primary/5 px-2 text-sm"
      >
        {shift
          ? compact
            ? shift.code
            : shiftName(shift, isRTL)
          : t("schedules.off")}
      </span>
    );
  }
  return (
    <NativeSelect
      aria-label={label}
      data-employee-id={employeeId}
      value={value}
      onChange={(event) => onChange(employeeId, date, event.target.value)}
      className={compact ? "px-2 text-center" : ""}
    >
      <option value="">{t("schedules.off")}</option>
      {shiftTypes.map((shift) => (
        <option key={shift.code} value={shift.code}>
          {compact ? shift.code : shiftName(shift, isRTL)}
        </option>
      ))}
    </NativeSelect>
  );
});
