import { useDeferredValue, useState, type FormEvent } from "react";
import {
  useCreateSchedule,
  useListEmployees,
  type Schedule,
  type ScheduleConstraints,
  type ScheduleUnavailability,
  type ShiftType,
} from "@workspace/api-client-react";
import { Plus, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorState } from "@/components/QueryErrorState";
import { useLanguage } from "@/lib/language-context";
import {
  cellKey,
  dateRange,
  employeeName,
  monthDates,
  scheduleErrorKey,
} from "./schedule-state";
import { NativeSelect, ScheduleLoading } from "./schedule-ui";

const DEFAULT_SHIFTS: ShiftType[] = [
  {
    code: "M",
    label: "Morning",
    labelAr: "صباحي",
    startTime: "07:00",
    endTime: "15:00",
    requiredPerDay: 1,
  },
  {
    code: "A",
    label: "Afternoon",
    labelAr: "مسائي",
    startTime: "15:00",
    endTime: "23:00",
    requiredPerDay: 1,
  },
  {
    code: "N",
    label: "Night",
    labelAr: "ليلي",
    startTime: "23:00",
    endTime: "07:00",
    requiredPerDay: 1,
  },
];

export function ScheduleCreate({
  month,
  onCreated,
}: {
  month: string;
  onCreated: (schedule: Schedule) => void;
}) {
  const { t, isRTL } = useLanguage();
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase());
  const [employeeIds, setEmployeeIds] = useState<number[]>([]);
  const [shiftTypes, setShiftTypes] = useState(DEFAULT_SHIFTS);
  const [constraints, setConstraints] = useState<ScheduleConstraints>({
    minRestHours: 11,
    maxConsecutiveDays: 5,
    maxShiftsPerMonth: 22,
  });
  const [unavailability, setUnavailability] = useState<
    ScheduleUnavailability[]
  >([]);
  const [unavailableEmployee, setUnavailableEmployee] = useState("");
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(`${month}-01`);
  const [rangeError, setRangeError] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const employeesQuery = useListEmployees({ isActive: true });
  const createMutation = useCreateSchedule({ mutation: { gcTime: 0 } });
  const employees = employeesQuery.data ?? [];
  const selectedSet = new Set(employeeIds);
  const selectedEmployees = employees.filter((employee) =>
    selectedSet.has(employee.id),
  );
  const selectedFacility = selectedEmployees[0]?.facilityId;
  const candidates = employees.filter(
    (employee) =>
      employee.isActive &&
      (!deferredSearch ||
        `${employee.name} ${employee.nameAr} ${employee.employeeNumber ?? ""}`
          .toLocaleLowerCase()
          .includes(deferredSearch)),
  );
  const dates = monthDates(month);

  function toggleEmployee(id: number) {
    setEmployeeIds((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
    setUnavailability((previous) =>
      previous.filter((entry) => entry.employeeId !== id),
    );
  }

  function blockDates() {
    const employeeId = Number(unavailableEmployee);
    const range = dateRange(month, from, to);
    if (!selectedSet.has(employeeId) || !range.length) {
      setRangeError(true);
      return;
    }
    setRangeError(false);
    setUnavailability((previous) => {
      const keys = new Set(
        previous.map((entry) => cellKey(entry.employeeId, entry.date)),
      );
      return [
        ...previous,
        ...range
          .filter((date) => !keys.has(cellKey(employeeId, date)))
          .map((date) => ({ employeeId, date })),
      ];
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!employeeIds.length || createMutation.isPending) return;
    setErrorKey(null);
    try {
      const result = await createMutation.mutateAsync({
        data: {
          title: title.trim(),
          month,
          employeeIds,
          shiftTypes,
          constraints,
          unavailability,
        },
      });
      onCreated(result);
    } catch (error) {
      setErrorKey(scheduleErrorKey(error, true));
    }
  }

  if (employeesQuery.isLoading) return <ScheduleLoading />;
  if (employeesQuery.isError)
    return (
      <QueryErrorState
        error={employeesQuery.error}
        onRetry={() => {
          void employeesQuery.refetch();
        }}
      />
    );

  return (
    <form onSubmit={submit} className="space-y-5">
      <fieldset
        disabled={createMutation.isPending}
        className="min-w-0 space-y-5"
      >
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <label className="block space-y-2 text-sm font-medium">
              <span>{t("schedules.title_label")}</span>
              <Input
                required
                maxLength={120}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("schedules.title_placeholder")}
                className="min-h-11"
              />
            </label>
            <div>
              <h2 className="font-semibold">
                {t("schedules.select_employees")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("schedules.team_hint")}
              </p>
            </div>
            <label className="relative block">
              <Search
                aria-hidden="true"
                className="absolute start-3 top-3.5 h-4 w-4 text-muted-foreground"
              />
              <Input
                type="search"
                aria-label={t("schedules.search_employees")}
                placeholder={t("schedules.search_employees")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="min-h-11 ps-9"
              />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span aria-live="polite">
                {employeeIds.length} {t("schedules.selected")}
              </span>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                onClick={() => {
                  setEmployeeIds([]);
                  setUnavailability([]);
                }}
              >
                {t("schedules.clear_selection")}
              </Button>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border divide-y">
              {candidates.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {t("schedules.no_employees")}
                </p>
              ) : (
                candidates.map((employee) => {
                  const differentFacility =
                    selectedFacility != null &&
                    employee.facilityId !== selectedFacility;
                  return (
                    <label
                      key={employee.id}
                      className={`flex min-h-14 items-center gap-3 p-3 ${differentFacility ? "opacity-50" : "cursor-pointer hover:bg-muted/40"}`}
                    >
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0 accent-primary"
                        checked={selectedSet.has(employee.id)}
                        disabled={
                          differentFacility ||
                          (!selectedSet.has(employee.id) &&
                            employeeIds.length >= 200)
                        }
                        onChange={() => toggleEmployee(employee.id)}
                      />
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-medium">
                          {employeeName(employee, isRTL)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {employee.employeeNumber ?? employee.id}
                          {differentFacility
                            ? ` · ${t("schedules.same_facility")}`
                            : ""}
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <div>
              <h2 className="font-semibold">{t("schedules.settings")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("schedules.settings_hint")}
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              {shiftTypes.map((shift, index) => (
                <fieldset
                  key={shift.code}
                  className="min-w-0 rounded-lg border p-3"
                >
                  <legend className="px-2 text-sm font-semibold">
                    {shift.code} ·{" "}
                    {t(`schedules.${["morning", "afternoon", "night"][index]}`)}
                  </legend>
                  <div className="space-y-3">
                    {(
                      [
                        "label",
                        "labelAr",
                        "startTime",
                        "endTime",
                        "requiredPerDay",
                      ] as const
                    ).map((field) => {
                      const label = {
                        label: "label",
                        labelAr: "label_ar",
                        startTime: "start",
                        endTime: "end",
                        requiredPerDay: "required",
                      }[field];
                      return (
                        <label
                          key={field}
                          className="block space-y-1 text-xs font-medium"
                        >
                          <span>{t(`schedules.${label}`)}</span>
                          <Input
                            required
                            dir={field === "labelAr" ? "rtl" : "ltr"}
                            type={
                              field === "requiredPerDay"
                                ? "number"
                                : field.endsWith("Time")
                                  ? "time"
                                  : "text"
                            }
                            min={0}
                            max={200}
                            maxLength={80}
                            value={shift[field]}
                            className="min-h-11"
                            onChange={(event) =>
                              setShiftTypes((previous) =>
                                previous.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        [field]:
                                          field === "requiredPerDay"
                                            ? Number(event.target.value)
                                            : event.target.value,
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
            <h3 className="font-semibold">{t("schedules.constraints")}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  "minRestHours",
                  "maxConsecutiveDays",
                  "maxShiftsPerMonth",
                ] as const
              ).map((field) => (
                <label key={field} className="block space-y-1.5 text-sm">
                  <span>
                    {t(
                      `schedules.${{ minRestHours: "rest", maxConsecutiveDays: "consecutive", maxShiftsPerMonth: "max_month" }[field]}`,
                    )}
                  </span>
                  <Input
                    type="number"
                    dir="ltr"
                    required
                    min={field === "minRestHours" ? 0 : 1}
                    max={field === "minRestHours" ? 24 : 31}
                    value={constraints[field]}
                    className="min-h-11"
                    onChange={(event) =>
                      setConstraints((previous) => ({
                        ...previous,
                        [field]: Number(event.target.value),
                      }))
                    }
                  />
                </label>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <div>
              <h2 className="font-semibold">
                {t("schedules.availability_title")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("schedules.availability_hint")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1.5 text-sm">
                <span>{t("schedules.employee")}</span>
                <NativeSelect
                  value={unavailableEmployee}
                  onChange={(event) =>
                    setUnavailableEmployee(event.target.value)
                  }
                >
                  <option value="">{t("schedules.choose_employee")}</option>
                  {selectedEmployees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employeeName(employee, isRTL)}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              {(["from", "to"] as const).map((field) => (
                <label key={field} className="space-y-1.5 text-sm">
                  <span>{t(`schedules.date_${field}`)}</span>
                  <Input
                    type="date"
                    dir="ltr"
                    className="min-h-11"
                    min={dates[0]}
                    max={dates.at(-1)}
                    value={field === "from" ? from : to}
                    onChange={(event) =>
                      field === "from"
                        ? setFrom(event.target.value)
                        : setTo(event.target.value)
                    }
                  />
                </label>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2"
              onClick={blockDates}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("schedules.add_unavailable")}
            </Button>
            {rangeError ? (
              <p role="alert" className="text-sm text-destructive">
                {t("schedules.invalid_range")}
              </p>
            ) : null}
            <div className="max-h-56 space-y-2 overflow-y-auto">
              {unavailability.length ? (
                unavailability.map((entry) => {
                  const employee = selectedEmployees.find(
                    (item) => item.id === entry.employeeId,
                  );
                  return (
                    <div
                      key={cellKey(entry.employeeId, entry.date)}
                      className="flex items-center justify-between gap-2 rounded-md bg-muted p-2 text-sm"
                    >
                      <span className="min-w-0 break-words">
                        {employee
                          ? employeeName(employee, isRTL)
                          : entry.employeeId}{" "}
                        · <bdi>{entry.date}</bdi>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 shrink-0"
                        aria-label={`${t("schedules.remove_unavailable")} ${entry.date} ${employee ? employeeName(employee, isRTL) : entry.employeeId}`}
                        onClick={() =>
                          setUnavailability((previous) =>
                            previous.filter(
                              (item) =>
                                cellKey(item.employeeId, item.date) !==
                                cellKey(entry.employeeId, entry.date),
                            ),
                          )
                        }
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("schedules.none_unavailable")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </fieldset>
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        {t("schedules.planning_notice")}
      </p>
      {errorKey ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`schedules.${errorKey}`)}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={
          !employeeIds.length || createMutation.isPending || !title.trim()
        }
        className="min-h-12 w-full gap-2 sm:w-auto"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        {t(
          createMutation.isPending
            ? "schedules.generating"
            : "schedules.generate",
        )}
      </Button>
    </form>
  );
}
