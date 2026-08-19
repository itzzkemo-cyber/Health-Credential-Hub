import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCredentialQueryKey,
  getGetEmployeeQueryKey,
  getListCredentialsQueryKey,
  useListCredentials,
  useListEmployees,
  useUpdateCredential,
  type Credential,
} from "@workspace/api-client-react";
import {
  BadgeCheck,
  ClipboardCheck,
  FileText,
  Loader2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";

import { QueryErrorState } from "@/components/QueryErrorState";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import {
  claimVerificationSubmission,
  releaseVerificationSubmission,
} from "./manager-verification";

const REVIEW_QUERY = { isVerified: false, page: 1, pageSize: 20 } as const;

/**
 * Management visibility here is a navigation boundary only. Both list hooks
 * and the verification mutation remain server-scoped and authorized.
 */
export function ManagerDashboard() {
  const { t, isRTL } = useLanguage();
  const queryClient = useQueryClient();
  const user = getAuthUser() as {
    role?: string;
    name?: string;
    nameAr?: string;
  } | null;
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [credentialToVerify, setCredentialToVerify] =
    useState<Credential | null>(null);
  const verificationLock = useRef(false);

  const employeesQuery = useListEmployees({ isActive: true });
  const credentialsQuery = useListCredentials(REVIEW_QUERY);
  const verifyCredential = useUpdateCredential();

  if (employeesQuery.isLoading || credentialsQuery.isLoading) {
    return (
      <div className="space-y-5" aria-busy="true">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }

  if (employeesQuery.isError || credentialsQuery.isError) {
    return (
      <QueryErrorState
        error={employeesQuery.error ?? credentialsQuery.error}
        onRetry={() => {
          void employeesQuery.refetch();
          void credentialsQuery.refetch();
        }}
      />
    );
  }

  const employees = employeesQuery.data ?? [];
  const reviewQueue = credentialsQuery.data?.data ?? [];
  const reviewQueueTotal = credentialsQuery.data?.total ?? 0;

  const handleConfirmVerify = () => {
    const credential = claimVerificationSubmission(
      credentialToVerify,
      verificationLock,
    );
    if (!credential) return;

    setVerifyingId(credential.id);
    verifyCredential.mutate(
      {
        id: credential.id,
        data: {
          expectedVersion: credential.version,
          isVerified: true,
        },
      },
      {
        onSuccess: () => {
          toast.success(t("manager_dashboard.verify_success"));
          void queryClient.invalidateQueries({
            queryKey: getListCredentialsQueryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: getGetCredentialQueryKey(credential.id),
          });
          void queryClient.invalidateQueries({
            queryKey: getGetEmployeeQueryKey(credential.employeeId),
          });
        },
        onError: () => {
          toast.error(t("manager_dashboard.verify_failed"));
          void credentialsQuery.refetch();
        },
        onSettled: () => {
          releaseVerificationSubmission(verificationLock);
          setVerifyingId(null);
          setCredentialToVerify(null);
        },
      },
    );
  };

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 md:space-y-7">
      <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card">
        <CardContent className="p-5 sm:p-7">
          <p className="text-sm font-medium text-primary">
            {t("manager_dashboard.eyebrow")}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            {t("auth.welcome_back")},{" "}
            {isRTL ? user?.nameAr || user?.name : user?.name || user?.nameAr}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
            {t("manager_dashboard.scope_hint")}
          </p>
        </CardContent>
      </Card>

      <section
        className="grid grid-cols-2 gap-3"
        aria-label={t("manager_dashboard.summary")}
      >
        <SummaryCard
          icon={UsersRound}
          label={t("manager_dashboard.scoped_employees")}
          value={employees.length}
        />
        <SummaryCard
          icon={ClipboardCheck}
          label={t("manager_dashboard.pending_review")}
          value={reviewQueueTotal}
          attention={reviewQueueTotal > 0}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">
              {t("manager_dashboard.team_title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {employees.length === 0 ? (
              <EmptyState
                icon={UsersRound}
                title={t("manager_dashboard.no_employees")}
                description={t("manager_dashboard.no_employees_hint")}
              />
            ) : (
              <div className="divide-y divide-border">
                {employees.slice(0, 6).map((employee) => (
                  <div
                    key={employee.id}
                    className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">
                        {isRTL ? employee.nameAr : employee.name}
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {isRTL
                          ? employee.jobTitleAr || employee.jobTitle
                          : employee.jobTitle || employee.jobTitleAr}
                      </p>
                    </div>
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="min-h-11 w-full shrink-0 gap-2 sm:w-auto"
                    >
                      <Link href={`/employees/${employee.id}`}>
                        <UserRound className="h-4 w-4" aria-hidden="true" />
                        {t("manager_dashboard.open_employee")}
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-lg">
                {t("manager_dashboard.review_queue")}
              </CardTitle>
              <Badge variant="secondary" className="shrink-0 tabular-nums">
                {reviewQueueTotal}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {reviewQueue.length === 0 ? (
              <EmptyState
                icon={BadgeCheck}
                title={t("manager_dashboard.review_empty")}
                description={t("manager_dashboard.review_empty_hint")}
              />
            ) : (
              <div className="space-y-3">
                {reviewQueue.slice(0, 8).map((credential) => (
                  <article
                    key={credential.id}
                    className="rounded-xl border border-border p-4"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <FileText className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate font-semibold">
                          {isRTL
                            ? credential.customTypeNameAr || credential.type
                            : credential.customTypeName || credential.type}
                        </h3>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {isRTL
                            ? credential.employee?.nameAr ||
                              credential.holderNameAr
                            : credential.employee?.name ||
                              credential.holderName}
                        </p>
                        <p
                          className="mt-1 truncate text-xs text-muted-foreground"
                          dir="ltr"
                        >
                          {credential.certificateNumber}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="min-h-11"
                      >
                        <Link href={`/employees/${credential.employeeId}`}>
                          {t("manager_dashboard.employee_file")}
                        </Link>
                      </Button>
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="min-h-11"
                      >
                        <Link href={`/credentials/${credential.id}`}>
                          {t("manager_dashboard.open_document")}
                        </Link>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="col-span-2 min-h-11 gap-2 sm:col-auto"
                        disabled={verifyCredential.isPending}
                        onClick={() => setCredentialToVerify(credential)}
                      >
                        {verifyCredential.isPending &&
                        verifyingId === credential.id ? (
                          <Loader2
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <BadgeCheck className="h-4 w-4" aria-hidden="true" />
                        )}
                        {t("manager_dashboard.verify")}
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={credentialToVerify !== null}
        onOpenChange={(open) => {
          if (!open && !verificationLock.current) {
            setCredentialToVerify(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("manager_dashboard.verify_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription className="leading-6">
              {t("manager_dashboard.verify_confirm_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {credentialToVerify && (
            <div className="min-w-0 rounded-lg border bg-muted/40 p-3">
              <p className="truncate font-semibold">
                {isRTL
                  ? credentialToVerify.customTypeNameAr ||
                    credentialToVerify.type
                  : credentialToVerify.customTypeName ||
                    credentialToVerify.type}
              </p>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {isRTL
                  ? credentialToVerify.employee?.nameAr ||
                    credentialToVerify.holderNameAr
                  : credentialToVerify.employee?.name ||
                    credentialToVerify.holderName}
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              className="min-h-11"
              disabled={verifyingId !== null || verifyCredential.isPending}
            >
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 gap-2"
              disabled={verifyingId !== null || verifyCredential.isPending}
              onClick={handleConfirmVerify}
            >
              {verifyingId !== null || verifyCredential.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <BadgeCheck className="h-4 w-4" aria-hidden="true" />
              )}
              {t("manager_dashboard.verify_confirm_action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  attention = false,
}: {
  icon: typeof UsersRound;
  label: string;
  value: number;
  attention?: boolean;
}) {
  return (
    <Card
      className={
        attention ? "border-amber-300/70 dark:border-amber-700" : undefined
      }
    >
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium leading-5 text-muted-foreground sm:text-sm">
            {label}
          </p>
          <Icon
            className={
              attention
                ? "h-5 w-5 shrink-0 text-amber-600"
                : "h-5 w-5 shrink-0 text-primary"
            }
            aria-hidden="true"
          />
        </div>
        <p className="mt-3 text-3xl font-bold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof UsersRound;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center px-3 py-9 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="h-7 w-7" aria-hidden="true" />
      </span>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
