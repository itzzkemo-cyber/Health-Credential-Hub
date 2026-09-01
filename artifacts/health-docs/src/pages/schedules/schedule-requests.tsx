import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMyScheduleRequestsQueryKey,
  getGetMySchedulesQueryKey,
  getGetScheduleRequestsForReviewQueryKey,
  useCreateScheduleRequest,
  useDecideScheduleRequest,
  useGetMyScheduleRequests,
  useGetMySchedules,
  useGetScheduleRequestsForReview,
  useWithdrawScheduleRequest,
  type GetScheduleRequestsForReviewParams,
  type ShiftRequest,
  type ShiftRequestStatus,
} from "@workspace/api-client-react";
import {
  CalendarCheck2,
  Check,
  CircleAlert,
  Clock3,
  Inbox,
  Send,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { QueryErrorState } from "@/components/QueryErrorState";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";
import { currentMonth, employeeName } from "./schedule-state";
import { NativeSelect, ScheduleLoading } from "./schedule-ui";
import {
  canRevokeApprovedScheduleRequest,
  canReviewScheduleRequest,
  canWithdrawScheduleRequest,
  requestErrorKey,
  requestReasonTranslationKey,
  scheduleRequestDecisionInput,
  scheduleRequestVersionInput,
  toCreateScheduleRequestInput,
  validateScheduleRequestForm,
  type ScheduleRequestFormValue,
  type ScheduleRequestKind,
} from "./schedule-request-state";

const INITIAL_DATE = `${currentMonth()}-01`;

export function ScheduleRequests({ manager }: { manager: boolean }) {
  const viewerId = (getAuthUser() as { id?: number } | null)?.id;
  return (
    <div className="space-y-8">
      <NewScheduleRequest />
      <MyScheduleRequests />
      {manager ? <TeamScheduleRequests reviewerId={viewerId} /> : null}
    </div>
  );
}

export function NewScheduleRequest({
  initialKind = "leave",
}: {
  initialKind?: ScheduleRequestKind;
} = {}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ScheduleRequestFormValue>({
    kind: initialKind,
    startDate: INITIAL_DATE,
    endDate: INITIAL_DATE,
    shiftCode: "",
    note: "",
  });
  const [validationKey, setValidationKey] = useState<string | null>(null);
  const requestMonth = form.startDate.slice(0, 7);
  const scheduleQuery = useGetMySchedules(
    { month: /^20\d{2}-(0[1-9]|1[0-2])$/.test(requestMonth) ? requestMonth : currentMonth() },
    {
      query: {
        queryKey: getGetMySchedulesQueryKey({
          month: /^20\d{2}-(0[1-9]|1[0-2])$/.test(requestMonth)
            ? requestMonth
            : currentMonth(),
        }),
        enabled: form.kind === "preferred_shift",
        gcTime: 0,
      },
    },
  );
  const shiftCodes = useMemo(
    () =>
      Array.from(
        new Set(
          (scheduleQuery.data ?? []).flatMap((schedule) =>
            schedule.shiftTypes.map((shift) => shift.code),
          ),
        ),
      ).sort(),
    [scheduleQuery.data],
  );
  const mutation = useCreateScheduleRequest();

  function updateKind(kind: ScheduleRequestKind) {
    setValidationKey(null);
    setForm((current) => ({
      ...current,
      kind,
      endDate: kind === "leave" ? current.endDate : current.startDate,
      shiftCode: kind === "preferred_shift" ? current.shiftCode : "",
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const issue = validateScheduleRequestForm(form);
    if (issue) {
      setValidationKey(`schedules.request_validation_${issue}`);
      return;
    }
    setValidationKey(null);
    const data = toCreateScheduleRequestInput(form);
    try {
      await mutation.mutateAsync({ data });
      setForm((current) => ({ ...current, note: "" }));
      await queryClient.invalidateQueries({
        queryKey: getGetMyScheduleRequestsQueryKey(),
      });
      toast.success(t("schedules.request_submitted"));
    } catch (error) {
      setValidationKey(`schedules.request_${requestErrorKey(error)}`);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-4 sm:p-6">
        <div className="space-y-1.5">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CalendarCheck2 className="h-5 w-5 text-primary" aria-hidden="true" />
            {t("schedules.request_new")}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            {t("schedules.request_new_hint")}
          </p>
        </div>

        <form className="space-y-5" onSubmit={submit} noValidate>
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t("schedules.request_kind")}</span>
            <NativeSelect
              className="min-h-11"
              value={form.kind}
              onChange={(event) =>
                updateKind(event.target.value as ScheduleRequestKind)
              }
            >
              <option value="leave">{t("schedules.request_kind_leave")}</option>
              <option value="preferred_shift">
                {t("schedules.request_kind_preferred_shift")}
              </option>
              <option value="off">{t("schedules.request_kind_off")}</option>
              <option value="eo">{t("schedules.request_kind_eo")}</option>
            </NativeSelect>
          </label>

          {form.kind === "eo" ? (
            <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              {t("schedules.request_kind_eo_hint")}
            </p>
          ) : null}

          <div
            className={cn(
              "grid gap-4",
              form.kind === "leave" ? "sm:grid-cols-2" : "sm:max-w-sm",
            )}
          >
            <label className="block space-y-1.5 text-sm font-medium">
              <span>
                {t(
                  form.kind === "leave"
                    ? "schedules.request_start_date"
                    : "schedules.request_date",
                )}
              </span>
              <Input
                className="min-h-11"
                dir="ltr"
                type="date"
                required
                value={form.startDate}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    startDate: event.target.value,
                    endDate:
                      current.kind === "leave"
                        ? current.endDate
                        : event.target.value,
                  }))
                }
              />
            </label>
            {form.kind === "leave" ? (
              <label className="block space-y-1.5 text-sm font-medium">
                <span>{t("schedules.request_end_date")}</span>
                <Input
                  className="min-h-11"
                  dir="ltr"
                  type="date"
                  required
                  value={form.endDate}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      endDate: event.target.value,
                    }))
                  }
                />
              </label>
            ) : null}
          </div>

          {form.kind === "preferred_shift" ? (
            <label className="block max-w-sm space-y-1.5 text-sm font-medium">
              <span>{t("schedules.request_shift_code")}</span>
              <Input
                className="min-h-11 uppercase"
                dir="ltr"
                list="schedule-request-shift-codes"
                maxLength={8}
                pattern="[A-Z][A-Z0-9_-]{0,7}"
                required
                autoComplete="off"
                placeholder={t("schedules.request_shift_code_placeholder")}
                value={form.shiftCode}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    shiftCode: event.target.value.toUpperCase(),
                  }))
                }
              />
              <datalist id="schedule-request-shift-codes">
                {shiftCodes.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
              <span className="block font-normal leading-5 text-muted-foreground">
                {t("schedules.request_shift_code_hint")}
              </span>
            </label>
          ) : null}

          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t("schedules.request_note")}</span>
            <Textarea
              className="min-h-24 resize-y"
              maxLength={500}
              placeholder={t("schedules.request_note_placeholder")}
              value={form.note}
              onChange={(event) =>
                setForm((current) => ({ ...current, note: event.target.value }))
              }
              aria-describedby="schedule-request-privacy"
            />
            <span
              id="schedule-request-privacy"
              className="block font-normal leading-5 text-muted-foreground"
            >
              {t("schedules.request_privacy_hint")}
            </span>
          </label>

          {validationKey ? (
            <Alert variant="destructive" aria-live="assertive">
              <CircleAlert className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{t(validationKey)}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            type="submit"
            className="min-h-11 w-full gap-2 sm:w-auto"
            disabled={mutation.isPending}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            {t(
              mutation.isPending
                ? "schedules.request_submitting"
                : "schedules.request_submit",
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MyScheduleRequests() {
  const { t, isRTL } = useLanguage();
  const queryClient = useQueryClient();
  const [actionId, setActionId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<ShiftRequest | null>(null);
  const query = useGetMyScheduleRequests({
    query: {
      queryKey: getGetMyScheduleRequestsQueryKey(),
      gcTime: 0,
      refetchOnWindowFocus: true,
    },
  });
  const withdraw = useWithdrawScheduleRequest();

  async function withdrawRequest(request: ShiftRequest) {
    setActionId(request.id);
    setActionError(null);
    try {
      await withdraw.mutateAsync({
        id: request.id,
        data: scheduleRequestVersionInput(request.version),
      });
      await queryClient.invalidateQueries({
        queryKey: getGetMyScheduleRequestsQueryKey(),
      });
      toast.success(t("schedules.request_withdrawn_success"));
    } catch (error) {
      setActionError(`schedules.request_${requestErrorKey(error)}`);
    } finally {
      setActionId(null);
      setWithdrawTarget(null);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="my-schedule-requests">
      <h2 id="my-schedule-requests" className="flex items-center gap-2 text-lg font-semibold">
        <Clock3 className="h-5 w-5 text-primary" aria-hidden="true" />
        {t("schedules.request_my")}
      </h2>
      {actionError ? (
        <RequestActionError
          message={actionError}
          onRefresh={() => {
            setActionError(null);
            void query.refetch();
          }}
        />
      ) : null}
      {query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <ScheduleLoading />
      ) : !query.data?.length ? (
        <RequestsEmpty team={false} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {query.data.map((request) => (
            <ScheduleRequestCard
              key={request.id}
              request={request}
              footer={
                canWithdrawScheduleRequest(request.status) ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full gap-2 sm:w-auto"
                    disabled={withdraw.isPending}
                    onClick={() => setWithdrawTarget(request)}
                  >
                    <Undo2 className="h-4 w-4" aria-hidden="true" />
                    {t(
                      actionId === request.id && withdraw.isPending
                        ? "schedules.request_withdrawing"
                        : "schedules.request_withdraw",
                    )}
                  </Button>
                ) : null
              }
            />
          ))}
        </div>
      )}
      <AlertDialog
        open={withdrawTarget !== null}
        onOpenChange={(open) => {
          if (!open) setWithdrawTarget(null);
        }}
      >
        <AlertDialogContent
          dir={isRTL ? "rtl" : "ltr"}
          className="max-w-[calc(100%-2rem)] sm:max-w-lg"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("schedules.request_withdraw_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("schedules.request_withdraw_hint")}
            </AlertDialogDescription>
            {withdrawTarget ? (
              <RequestConfirmationDetails request={withdrawTarget} />
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
              disabled={withdraw.isPending}
              onClick={() => {
                if (withdrawTarget) void withdrawRequest(withdrawTarget);
              }}
            >
              {t("schedules.request_withdraw_confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function TeamScheduleRequests({ reviewerId }: { reviewerId?: number }) {
  const { t, isRTL } = useLanguage();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ShiftRequestStatus | "all">("pending");
  const [actionId, setActionId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [decisionTarget, setDecisionTarget] = useState<{
    request: ShiftRequest;
    decision: "approved" | "rejected";
  } | null>(null);
  const params: GetScheduleRequestsForReviewParams | undefined =
    status === "all" ? undefined : { status };
  const query = useGetScheduleRequestsForReview(params, {
    query: {
      queryKey: getGetScheduleRequestsForReviewQueryKey(params),
      gcTime: 0,
      refetchOnWindowFocus: true,
    },
  });
  const decide = useDecideScheduleRequest();

  async function decideRequest(
    request: ShiftRequest,
    decision: "approved" | "rejected",
  ) {
    setActionId(request.id);
    setActionError(null);
    try {
      await decide.mutateAsync({
        id: request.id,
        data: scheduleRequestDecisionInput(request.version, decision),
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetScheduleRequestsForReviewQueryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetMyScheduleRequestsQueryKey(),
        }),
      ]);
      toast.success(
        t(
          request.status === "approved" && decision === "rejected"
            ? "schedules.request_revoked_success"
            : decision === "approved"
            ? "schedules.request_approved_success"
            : "schedules.request_rejected_success",
        ),
      );
    } catch (error) {
      setActionError(`schedules.request_${requestErrorKey(error)}`);
    } finally {
      setActionId(null);
      setDecisionTarget(null);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="team-schedule-requests">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 id="team-schedule-requests" className="flex items-center gap-2 text-lg font-semibold">
            <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
            {t("schedules.request_team")}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            {t("schedules.request_team_hint")}
          </p>
        </div>
        <label className="block min-w-48 space-y-1.5 text-sm font-medium">
          <span>{t("schedules.request_status")}</span>
          <NativeSelect
            className="min-h-11"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as ShiftRequestStatus | "all")
            }
          >
            <option value="pending">{t("schedules.request_status_pending")}</option>
            <option value="approved">{t("schedules.request_status_approved")}</option>
            <option value="rejected">{t("schedules.request_status_rejected")}</option>
            <option value="withdrawn">{t("schedules.request_status_withdrawn")}</option>
            <option value="all">{t("common.all")}</option>
          </NativeSelect>
        </label>
      </div>
      {actionError ? (
        <RequestActionError
          message={actionError}
          onRefresh={() => {
            setActionError(null);
            void query.refetch();
          }}
        />
      ) : null}
      {query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <ScheduleLoading />
      ) : !query.data?.length ? (
        <RequestsEmpty team />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {query.data.map((request) => {
            const reviewable = canReviewScheduleRequest({
              status: request.status,
              employeeId: request.employee.id,
              reviewerId,
              manager: true,
            });
            const revocable = canRevokeApprovedScheduleRequest({
              status: request.status,
              employeeId: request.employee.id,
              reviewerId,
              manager: true,
            });
            return (
              <ScheduleRequestCard
                key={request.id}
                request={request}
                showEmployee
                footer={
                  reviewable ? (
                    <div className="grid grid-cols-2 gap-2 sm:flex">
                      <Button
                        type="button"
                        className="min-h-11 gap-2"
                        disabled={decide.isPending}
                        onClick={() =>
                          setDecisionTarget({ request, decision: "approved" })
                        }
                      >
                        <Check className="h-4 w-4" aria-hidden="true" />
                        {actionId === request.id && decide.isPending
                          ? t("schedules.request_deciding")
                          : t("schedules.request_approve")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 gap-2 border-destructive/40 text-destructive hover:text-destructive"
                        disabled={decide.isPending}
                        onClick={() =>
                          setDecisionTarget({ request, decision: "rejected" })
                        }
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                        {t("schedules.request_reject")}
                      </Button>
                    </div>
                  ) : revocable ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 gap-2 border-destructive/40 text-destructive hover:text-destructive"
                      disabled={decide.isPending}
                      onClick={() =>
                        setDecisionTarget({ request, decision: "rejected" })
                      }
                    >
                      <Undo2 className="h-4 w-4" aria-hidden="true" />
                      {t("schedules.request_revoke_approval")}
                    </Button>
                  ) : null
                }
              />
            );
          })}
        </div>
      )}
      <AlertDialog
        open={decisionTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDecisionTarget(null);
        }}
      >
        <AlertDialogContent
          dir={isRTL ? "rtl" : "ltr"}
          className="max-w-[calc(100%-2rem)] sm:max-w-lg"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("schedules.request_decision_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                decisionTarget?.request.status === "approved" &&
                  decisionTarget.decision === "rejected"
                  ? "schedules.request_revoke_approval_hint"
                  : decisionTarget?.decision === "approved"
                  ? "schedules.request_approve_hint"
                  : "schedules.request_reject_hint",
              )}
            </AlertDialogDescription>
            {decisionTarget ? (
              <RequestConfirmationDetails
                request={decisionTarget.request}
                showEmployee
              />
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                "min-h-11",
                decisionTarget?.decision === "rejected" &&
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
              disabled={decide.isPending}
              onClick={() => {
                if (decisionTarget)
                  void decideRequest(
                    decisionTarget.request,
                    decisionTarget.decision,
                  );
              }}
            >
              {t(
                decisionTarget?.request.status === "approved" &&
                  decisionTarget.decision === "rejected"
                  ? "schedules.request_revoke_approval"
                  : decisionTarget?.decision === "approved"
                  ? "schedules.request_approve"
                  : "schedules.request_reject",
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function ScheduleRequestCard({
  request,
  showEmployee = false,
  footer,
}: {
  request: ShiftRequest;
  showEmployee?: boolean;
  footer?: ReactNode;
}) {
  const { t, isRTL } = useLanguage();
  const dateLabel =
    request.startDate === request.endDate
      ? request.startDate
      : `${request.startDate} – ${request.endDate}`;
  const feasibilityVariant =
    request.feasibility.status === "conflict"
      ? "destructive"
      : request.feasibility.status === "unknown"
        ? "outline"
        : "secondary";
  const statusVariant =
    request.status === "approved"
      ? "default"
      : request.status === "rejected"
        ? "destructive"
        : "secondary";

  return (
    <Card className="min-w-0">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="break-words font-semibold">
              {t(`schedules.request_kind_${request.kind}`)}
            </h3>
            {showEmployee ? (
              <p className="break-words text-sm text-muted-foreground">
                {t("schedules.request_employee")}: {employeeName(request.employee, isRTL)}
              </p>
            ) : null}
          </div>
          <Badge variant={statusVariant}>
            {t(`schedules.request_status_${request.status}`)}
          </Badge>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0 rounded-lg bg-muted/40 p-3">
            <dt className="text-muted-foreground">{t("schedules.request_period")}</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              <bdi>{dateLabel}</bdi>
            </dd>
          </div>
          {request.shiftCode ? (
            <div className="min-w-0 rounded-lg bg-muted/40 p-3">
              <dt className="text-muted-foreground">
                {t("schedules.request_shift_code")}
              </dt>
              <dd className="mt-1 font-medium" dir="ltr">
                <bdi>{request.shiftCode}</bdi>
              </dd>
            </div>
          ) : null}
          <div className="min-w-0 rounded-lg bg-muted/40 p-3">
            <dt className="text-muted-foreground">{t("schedules.request_created")}</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              <time dateTime={request.createdAt}>{request.createdAt.slice(0, 10)}</time>
            </dd>
          </div>
        </dl>

        {request.note ? (
          <p className="whitespace-pre-wrap break-words rounded-lg border p-3 text-sm leading-6">
            {request.note}
          </p>
        ) : null}

        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {t("schedules.request_feasibility")}
            </span>
            <Badge variant={feasibilityVariant}>
              {t(
                `schedules.request_feasibility_${request.feasibility.status}`,
              )}
            </Badge>
          </div>
          {request.feasibility.reasonCodes.length ? (
            <ul className="list-disc space-y-1 ps-5 text-sm leading-6 text-muted-foreground">
              {request.feasibility.reasonCodes.map((code, index) => (
                <li key={`${code}:${index}`}>
                  {t(requestReasonTranslationKey(code))}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            {t("schedules.request_feasibility_disclaimer")}
          </p>
        </div>

        {footer ? <div className="border-t pt-4">{footer}</div> : null}
      </CardContent>
    </Card>
  );
}

function RequestConfirmationDetails({
  request,
  showEmployee = false,
}: {
  request: ShiftRequest;
  showEmployee?: boolean;
}) {
  const { t, isRTL } = useLanguage();
  return (
    <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm text-foreground sm:grid-cols-2">
      {showEmployee ? (
        <div className="min-w-0">
          <dt className="text-muted-foreground">
            {t("schedules.request_employee")}
          </dt>
          <dd className="break-words font-medium">
            {employeeName(request.employee, isRTL)}
          </dd>
        </div>
      ) : null}
      <div className="min-w-0">
        <dt className="text-muted-foreground">{t("schedules.request_kind")}</dt>
        <dd className="font-medium">
          {t(`schedules.request_kind_${request.kind}`)}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-muted-foreground">{t("schedules.request_period")}</dt>
        <dd className="font-medium" dir="ltr">
          <bdi>
            {request.startDate === request.endDate
              ? request.startDate
              : `${request.startDate} – ${request.endDate}`}
          </bdi>
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-muted-foreground">
          {t("schedules.request_feasibility")}
        </dt>
        <dd className="font-medium">
          {t(`schedules.request_feasibility_${request.feasibility.status}`)}
        </dd>
      </div>
    </dl>
  );
}

function RequestsEmpty({ team }: { team: boolean }) {
  const { t } = useLanguage();
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
        <Inbox className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h3 className="font-semibold">
            {t(team ? "schedules.request_team_empty" : "schedules.request_empty")}
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {t(
              team
                ? "schedules.request_team_empty_hint"
                : "schedules.request_empty_hint",
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function RequestActionError({
  message,
  onRefresh,
}: {
  message: string;
  onRefresh: () => void;
}) {
  const { t } = useLanguage();
  return (
    <Alert variant="destructive" aria-live="assertive">
      <CircleAlert className="h-4 w-4" aria-hidden="true" />
      <AlertDescription className="space-y-3">
        <p>{t(message)}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 gap-2"
          onClick={onRefresh}
        >
          <Undo2 className="h-4 w-4" aria-hidden="true" />
          {t("schedules.request_refresh")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
