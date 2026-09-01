import { useDeferredValue, useRef, useState } from "react";
import {
  ApiError,
  type EmployeeInvitation,
  type EmployeeWithStats,
  getGetFacilitiesQueryKey,
  useGetFacilities,
  getListDepartmentsQueryKey,
  getListEmployeeInvitationsQueryKey,
  getListEmployeesQueryKey,
  useCreateEmployee,
  useCreateEmployeeInvitation,
  useListDepartments,
  useListEmployeeInvitations,
  useListEmployees,
  useRevokeEmployeeInvitation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertCircle,
  Clock,
  Copy,
  Eye,
  EyeOff,
  HeartPulse,
  KeyRound,
  Loader2,
  MailPlus,
  MailX,
  Plus,
  Search,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { QueryErrorState } from "@/components/QueryErrorState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";
import {
  buildEmployeeInput,
  buildEmployeeInvitationInput,
  generateTemporaryPassword,
  type EmployeeAccountForm,
  getComplianceRate,
  getDepartmentOptions,
  getEmployeeDisplayName,
  getEmployeeInitial,
  getInvitationDisplayName,
  getInvitationListParams,
  getSupervisorOptions,
  getAssignableRoles,
  isPasswordDeliveryReady,
  isEmployeeInvitationPhoneValid,
  requiresEmployeeCreateStepUp,
} from "./employee-list-state";
import { getDepartmentQueryParams } from "./department-query";
import {
  ADMIN_MFA_CODE_FIELD,
  ADMIN_MFA_CURRENT_PASSWORD_FIELD,
  getAdminMfaStepUpErrorKey,
  readAdminMfaStepUpCredentials,
} from "./admin-mfa-step-up";

function apiErrorCode(error: unknown): string | undefined {
  return error instanceof ApiError
    ? (error.data as { code?: string } | null)?.code
    : undefined;
}

type EmployeeDialogMode = "direct" | "invitation";

export default function EmployeesList() {
  const { t, isRTL } = useLanguage();
  const queryClient = useQueryClient();
  const user = getAuthUser() as {
    id?: number;
    role?: string;
    facilityId?: number;
  } | null;
  const isSystemAdmin = user?.role === "system_admin";
  const canCreateEmployee = user?.role === "hospital_admin" || isSystemAdmin;
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [invitationFacilityFilter, setInvitationFacilityFilter] = useState("");
  const [invitationToRevoke, setInvitationToRevoke] =
    useState<EmployeeInvitation | null>(null);
  const [revokeFeedbackKey, setRevokeFeedbackKey] = useState<string | null>(
    null,
  );
  const [employeeDialogMode, setEmployeeDialogMode] =
    useState<EmployeeDialogMode>("invitation");
  const [showTemporaryPassword, setShowTemporaryPassword] = useState(false);
  const [passwordDeliveryAcknowledged, setPasswordDeliveryAcknowledged] =
    useState(false);
  const [createFeedbackKey, setCreateFeedbackKey] = useState<string | null>(
    null,
  );
  const createStepUpPasswordRef = useRef<HTMLInputElement>(null);
  const createStepUpCodeRef = useRef<HTMLInputElement>(null);
  const revokeStepUpPasswordRef = useRef<HTMLInputElement>(null);
  const revokeStepUpCodeRef = useRef<HTMLInputElement>(null);
  const [employeeForm, setEmployeeForm] = useState(() =>
    createEmptyEmployeeForm(isSystemAdmin ? user?.facilityId : undefined),
  );
  const deferredSearch = useDeferredValue(search.trim());
  const selectedFacilityId = employeeForm.facilityId
    ? Number(employeeForm.facilityId)
    : (user?.facilityId ?? null);

  const employeesQuery = useListEmployees({
    search: deferredSearch || undefined,
  });
  const departmentDirectoryParams = getDepartmentQueryParams(
    user?.role,
    selectedFacilityId,
  );
  const departmentsQuery = useListDepartments(departmentDirectoryParams, {
    query: {
      queryKey: getListDepartmentsQueryKey(departmentDirectoryParams),
      enabled:
        canCreateEmployee && (!isSystemAdmin || selectedFacilityId != null),
    },
  });
  const facilitiesQuery = useGetFacilities({
    query: {
      queryKey: getGetFacilitiesQueryKey(),
      enabled: isSystemAdmin,
    },
  });
  const managementDirectoryParams =
    isSystemAdmin && selectedFacilityId != null
      ? { facilityId: selectedFacilityId }
      : undefined;
  const managementDirectoryQuery = useListEmployees(managementDirectoryParams, {
    query: {
      queryKey: getListEmployeesQueryKey(managementDirectoryParams),
      enabled: canCreateEmployee && isCreateOpen,
    },
  });
  const createEmployee = useCreateEmployee({ mutation: { gcTime: 0 } });
  const createEmployeeInvitation = useCreateEmployeeInvitation({
    mutation: { gcTime: 0 },
  });
  const invitationListParams = getInvitationListParams(
    user?.role,
    invitationFacilityFilter,
  );
  const invitationsQuery = useListEmployeeInvitations(invitationListParams, {
    query: {
      queryKey: getListEmployeeInvitationsQueryKey(invitationListParams),
      enabled: canCreateEmployee,
    },
  });
  const revokeEmployeeInvitation = useRevokeEmployeeInvitation({
    mutation: { gcTime: 0 },
  });
  const employees = employeesQuery.data ?? [];
  const invitations = invitationsQuery.data ?? [];
  const assignableRoles = getAssignableRoles(user?.role ?? "");
  const managementDirectory = managementDirectoryQuery.data ?? [];
  const departmentOptions = getDepartmentOptions(
    departmentsQuery.data ?? [],
    managementDirectory,
    selectedFacilityId,
  );
  const supervisorOptions = getSupervisorOptions(
    managementDirectory,
    null,
    selectedFacilityId,
  );
  const createRequiresStepUp = requiresEmployeeCreateStepUp(employeeForm.role);
  const isInvitationMode = employeeDialogMode === "invitation";
  const dialogRequiresStepUp = isInvitationMode || createRequiresStepUp;
  const employeeActionPending =
    createEmployee.isPending || createEmployeeInvitation.isPending;

  const clearCreateStepUpSecrets = () => {
    if (createStepUpPasswordRef.current) {
      createStepUpPasswordRef.current.value = "";
    }
    if (createStepUpCodeRef.current) createStepUpCodeRef.current.value = "";
  };

  const resetCreateEmployeeForm = () => {
    clearCreateStepUpSecrets();
    createEmployee.reset();
    createEmployeeInvitation.reset();
    setEmployeeForm(
      createEmptyEmployeeForm(isSystemAdmin ? user?.facilityId : undefined),
    );
    setShowTemporaryPassword(false);
    setPasswordDeliveryAcknowledged(false);
    setCreateFeedbackKey(null);
  };

  const openCreateEmployee = () => {
    resetCreateEmployeeForm();
    setEmployeeDialogMode("direct");
    setIsCreateOpen(true);
  };

  const openInviteEmployee = () => {
    resetCreateEmployeeForm();
    setEmployeeDialogMode("invitation");
    setEmployeeForm((previous) => ({ ...previous, role: "employee" }));
    setIsCreateOpen(true);
  };

  const closeCreateEmployee = () => {
    if (employeeActionPending) return;
    resetCreateEmployeeForm();
    setIsCreateOpen(false);
  };

  const generatePassword = () => {
    setEmployeeForm((previous) => ({
      ...previous,
      password: generateTemporaryPassword(),
    }));
    setShowTemporaryPassword(true);
    setPasswordDeliveryAcknowledged(false);
  };

  const copyTemporaryPassword = async () => {
    if (!employeeForm.password) return;
    try {
      await navigator.clipboard.writeText(employeeForm.password);
      toast.success(t("employees_page.password_copied"));
    } catch {
      toast.error(t("employees_page.password_copy_failed"));
    }
  };

  const handleCreateEmployee = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      isInvitationMode &&
      !isEmployeeInvitationPhoneValid(employeeForm.phone)
    ) {
      setCreateFeedbackKey("employees_page.phone_invitation_required");
      requestAnimationFrame(() =>
        document.getElementById("employee-phone")?.focus(),
      );
      return;
    }
    if (
      !isInvitationMode &&
      !isPasswordDeliveryReady(
        employeeForm.password,
        passwordDeliveryAcknowledged,
      )
    ) {
      return;
    }

    setCreateFeedbackKey(null);
    const form = event.currentTarget;
    const stepUp = readAdminMfaStepUpCredentials(new FormData(form));
    if (!stepUp) {
      setCreateFeedbackKey("employees_page.step_up_required");
      createStepUpPasswordRef.current?.focus();
      return;
    }

    if (isInvitationMode && stepUp) {
      createEmployeeInvitation.mutate(
        {
          data: buildEmployeeInvitationInput(employeeForm, stepUp),
        },
        {
          onSuccess: () => {
            clearCreateStepUpSecrets();
            createEmployeeInvitation.reset();
            toast.success(t("employees_page.invitation_sent"));
            setIsCreateOpen(false);
            setEmployeeForm(
              createEmptyEmployeeForm(
                isSystemAdmin ? user?.facilityId : undefined,
              ),
            );
            setCreateFeedbackKey(null);
            void queryClient.invalidateQueries({
              queryKey: getListEmployeeInvitationsQueryKey(),
            });
          },
          onError: (error: unknown) => {
            const fallbackKey =
              error instanceof ApiError && error.status === 409
                ? "employees_page.email_exists"
                : "employees_page.invitation_failed";
            const errorKey = getAdminMfaStepUpErrorKey(
              apiErrorCode(error),
              fallbackKey,
            );
            clearCreateStepUpSecrets();
            createEmployeeInvitation.reset();
            setCreateFeedbackKey(errorKey);
            requestAnimationFrame(() =>
              createStepUpPasswordRef.current?.focus(),
            );
          },
        },
      );
      return;
    }

    createEmployee.mutate(
      {
        data: buildEmployeeInput(employeeForm, stepUp),
      },
      {
        onSuccess: () => {
          clearCreateStepUpSecrets();
          createEmployee.reset();
          toast.success(t("employees_page.create_success"));
          setIsCreateOpen(false);
          setEmployeeForm(
            createEmptyEmployeeForm(
              isSystemAdmin ? user?.facilityId : undefined,
            ),
          );
          setShowTemporaryPassword(false);
          setPasswordDeliveryAcknowledged(false);
          setCreateFeedbackKey(null);
          void queryClient.invalidateQueries({
            queryKey: getListEmployeesQueryKey(),
          });
        },
        onError: (error) => {
          const fallbackKey =
            error instanceof ApiError && error.status === 409
              ? "employees_page.email_exists"
              : "employees_page.create_failed";
          const errorKey = getAdminMfaStepUpErrorKey(
            apiErrorCode(error),
            fallbackKey,
          );
          clearCreateStepUpSecrets();
          createEmployee.reset();
          setCreateFeedbackKey(errorKey);
          requestAnimationFrame(() => createStepUpPasswordRef.current?.focus());
        },
      },
    );
  };

  const clearRevokeStepUpSecrets = () => {
    if (revokeStepUpPasswordRef.current) {
      revokeStepUpPasswordRef.current.value = "";
    }
    if (revokeStepUpCodeRef.current) revokeStepUpCodeRef.current.value = "";
  };

  const openRevokeInvitation = (invitation: EmployeeInvitation) => {
    clearRevokeStepUpSecrets();
    revokeEmployeeInvitation.reset();
    setRevokeFeedbackKey(null);
    setInvitationToRevoke(invitation);
  };

  const closeRevokeInvitation = () => {
    if (revokeEmployeeInvitation.isPending) return;
    clearRevokeStepUpSecrets();
    revokeEmployeeInvitation.reset();
    setRevokeFeedbackKey(null);
    setInvitationToRevoke(null);
  };

  const handleRevokeInvitation = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!invitationToRevoke) return;

    const stepUp = readAdminMfaStepUpCredentials(
      new FormData(event.currentTarget),
    );
    if (!stepUp) {
      setRevokeFeedbackKey("employees_page.step_up_required");
      revokeStepUpPasswordRef.current?.focus();
      return;
    }

    setRevokeFeedbackKey(null);
    revokeEmployeeInvitation.mutate(
      { id: invitationToRevoke.id, data: stepUp },
      {
        onSuccess: () => {
          clearRevokeStepUpSecrets();
          revokeEmployeeInvitation.reset();
          setInvitationToRevoke(null);
          toast.success(t("employees_page.invitation_revoked"));
          void queryClient.invalidateQueries({
            queryKey: getListEmployeeInvitationsQueryKey(),
          });
        },
        onError: (error: unknown) => {
          const status = error instanceof ApiError ? error.status : undefined;
          const fallbackKey =
            status === 404
              ? "employees_page.invitation_revoke_not_found"
              : status === 429
                ? "employees_page.invitation_revoke_rate_limited"
                : "employees_page.invitation_revoke_failed";
          setRevokeFeedbackKey(
            getAdminMfaStepUpErrorKey(apiErrorCode(error), fallbackKey),
          );
          clearRevokeStepUpSecrets();
          revokeEmployeeInvitation.reset();
          requestAnimationFrame(() => revokeStepUpPasswordRef.current?.focus());
        },
      },
    );
  };

  return (
    <div className="space-y-5 animate-in fade-in duration-500 sm:space-y-6">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {t("common.employees")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            {t("employees_page.subtitle")}
          </p>
        </div>
        {canCreateEmployee && (
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="outline"
              onClick={openCreateEmployee}
              className="min-h-11 w-full gap-2 sm:w-auto"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("employees_page.add_employee_directly")}
            </Button>
            <Button
              type="button"
              onClick={openInviteEmployee}
              className="min-h-11 w-full gap-2 sm:w-auto"
            >
              <MailPlus className="h-4 w-4" aria-hidden="true" />
              {t("employees_page.invite_employee")}
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
        <div className="relative w-full">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={t("employees_page.search_label")}
            placeholder={t("employees_page.search_placeholder")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-h-11 bg-background ps-9"
          />
        </div>
      </div>

      {canCreateEmployee && (
        <section
          className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5"
          aria-labelledby="active-invitations-title"
          aria-busy={invitationsQuery.isFetching}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" aria-hidden="true" />
                <h2 id="active-invitations-title" className="text-lg font-bold">
                  {t("employees_page.active_invitations")}
                </h2>
                {!invitationsQuery.isLoading && (
                  <Badge
                    variant="secondary"
                    aria-label={`${t("employees_page.invitation_count")}: ${invitations.length}`}
                  >
                    {invitations.length}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t("employees_page.active_invitations_hint")}
              </p>
            </div>

            {isSystemAdmin && (
              <div className="w-full space-y-2 sm:w-64">
                <Label htmlFor="invitation-facility-filter">
                  {t("employees_page.invitation_facility_filter")}
                </Label>
                <Select
                  value={invitationFacilityFilter || "all"}
                  onValueChange={(value) =>
                    setInvitationFacilityFilter(value === "all" ? "" : value)
                  }
                >
                  <SelectTrigger
                    id="invitation-facility-filter"
                    className="min-h-11"
                    disabled={facilitiesQuery.isLoading}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t("employees_page.all_facilities")}
                    </SelectItem>
                    {(facilitiesQuery.data ?? []).map((facility) => (
                      <SelectItem key={facility.id} value={String(facility.id)}>
                        {isRTL ? facility.nameAr : facility.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <p className="sr-only" role="status" aria-live="polite">
            {!invitationsQuery.isLoading && !invitationsQuery.isError
              ? `${t("employees_page.invitation_count")}: ${invitations.length}`
              : ""}
          </p>
          <div>
            {invitationsQuery.isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Skeleton className="h-56 rounded-xl" />
                <Skeleton className="h-56 rounded-xl" />
              </div>
            ) : invitationsQuery.isError ? (
              <QueryErrorState
                error={invitationsQuery.error}
                onRetry={() => void invitationsQuery.refetch()}
              />
            ) : invitations.length === 0 ? (
              <div className="rounded-xl border border-dashed px-4 py-8 text-center">
                <MailPlus
                  className="mx-auto mb-3 h-10 w-10 text-muted-foreground opacity-30"
                  aria-hidden="true"
                />
                <p className="font-medium">
                  {t("employees_page.no_active_invitations")}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("employees_page.no_active_invitations_hint")}
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {invitations.map((invitation) => {
                  const facility = (facilitiesQuery.data ?? []).find(
                    (candidate) => candidate.id === invitation.facilityId,
                  );
                  const facilityLabel = isSystemAdmin
                    ? facility
                      ? isRTL
                        ? facility.nameAr
                        : facility.name
                      : `${t("employees_page.facility")} #${invitation.facilityId}`
                    : undefined;

                  return (
                    <InvitationCard
                      key={invitation.id}
                      invitation={invitation}
                      isRTL={isRTL}
                      facilityLabel={facilityLabel}
                      t={t}
                      onRevoke={() => openRevokeInvitation(invitation)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      <section aria-busy={employeesQuery.isFetching} aria-live="polite">
        {employeesQuery.isLoading ? (
          <EmployeeListSkeleton loadingLabel={t("common.loading")} />
        ) : employeesQuery.isError ? (
          <QueryErrorState
            error={employeesQuery.error}
            onRetry={() => void employeesQuery.refetch()}
          />
        ) : employees.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card px-4 py-12 text-center">
            <HeartPulse
              className="mx-auto mb-4 h-12 w-12 text-muted-foreground opacity-20"
              aria-hidden="true"
            />
            <h2 className="text-lg font-medium">
              {deferredSearch
                ? t("employees_page.no_search_results")
                : t("employees_page.empty")}
            </h2>
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:hidden">
              {employees.map((employee) => (
                <EmployeeMobileCard
                  key={employee.id}
                  employee={employee}
                  isRTL={isRTL}
                  t={t}
                />
              ))}
            </div>

            <div className="hidden overflow-hidden rounded-xl border border-border bg-card shadow-sm md:block">
              <table className="w-full text-start text-sm">
                <thead className="border-b border-border bg-muted/50 font-medium text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-5 py-4 text-start">
                      {t("employees_page.employee")}
                    </th>
                    <th scope="col" className="px-5 py-4 text-start">
                      {t("employees_page.role")}
                    </th>
                    <th scope="col" className="px-5 py-4 text-start">
                      {t("employees_page.status")}
                    </th>
                    <th scope="col" className="px-5 py-4 text-start">
                      {t("employees_page.compliance")}
                    </th>
                    <th scope="col" className="px-5 py-4 text-end">
                      {t("common.actions")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {employees.map((employee) => (
                    <EmployeeTableRow
                      key={employee.id}
                      employee={employee}
                      isRTL={isRTL}
                      t={t}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          if (open) setIsCreateOpen(true);
          else closeCreateEmployee();
        }}
      >
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t(
                isInvitationMode
                  ? "employees_page.invite_employee"
                  : "employees_page.add_employee",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                isInvitationMode
                  ? "employees_page.invite_employee_description"
                  : "employees_page.add_employee_description",
              )}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateEmployee} className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <EmployeeFormField
                id="employee-name-en"
                label={t("employees_page.name_english")}
                value={employeeForm.name}
                onChange={(name) =>
                  setEmployeeForm((previous) => ({ ...previous, name }))
                }
                dir="ltr"
              />
              <EmployeeFormField
                id="employee-name-ar"
                label={t("employees_page.name_arabic")}
                value={employeeForm.nameAr}
                onChange={(nameAr) =>
                  setEmployeeForm((previous) => ({ ...previous, nameAr }))
                }
                dir="rtl"
              />
              <EmployeeFormField
                id="employee-email"
                label={t("employees_page.email")}
                value={employeeForm.email}
                onChange={(email) =>
                  setEmployeeForm((previous) => ({ ...previous, email }))
                }
                type="email"
                dir="ltr"
              />
              <EmployeeFormField
                id="employee-number"
                label={t("employees_page.employee_number")}
                value={employeeForm.employeeNumber}
                onChange={(employeeNumber) =>
                  setEmployeeForm((previous) => ({
                    ...previous,
                    employeeNumber,
                  }))
                }
                dir="ltr"
              />
              <div className="space-y-2">
                <Label htmlFor="employee-phone">
                  {t("employees_page.phone")}
                </Label>
                <Input
                  id="employee-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={32}
                  required={isInvitationMode}
                  value={employeeForm.phone ?? ""}
                  onChange={(event) => {
                    setEmployeeForm((previous) => ({
                      ...previous,
                      phone: event.target.value,
                    }));
                    setCreateFeedbackKey(null);
                  }}
                  dir="ltr"
                  className="min-h-11"
                  placeholder="05XXXXXXXX"
                  aria-describedby={
                    isInvitationMode
                      ? "employee-phone-invitation-hint"
                      : undefined
                  }
                />
                {isInvitationMode && (
                  <p
                    id="employee-phone-invitation-hint"
                    className="text-xs leading-5 text-muted-foreground"
                  >
                    {t("employees_page.phone_invitation_hint")}
                  </p>
                )}
              </div>
              <EmployeeFormField
                id="employee-job-title-en"
                label={t("employees_page.job_title_english")}
                value={employeeForm.jobTitle}
                onChange={(jobTitle) =>
                  setEmployeeForm((previous) => ({ ...previous, jobTitle }))
                }
                dir="ltr"
              />
              <EmployeeFormField
                id="employee-job-title-ar"
                label={t("employees_page.job_title_arabic")}
                value={employeeForm.jobTitleAr}
                onChange={(jobTitleAr) =>
                  setEmployeeForm((previous) => ({ ...previous, jobTitleAr }))
                }
                dir="rtl"
              />

              {isSystemAdmin && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="employee-facility">
                    {t("employees_page.facility")}
                  </Label>
                  <Select
                    value={employeeForm.facilityId}
                    onValueChange={(facilityId) =>
                      setEmployeeForm((previous) => ({
                        ...previous,
                        facilityId,
                        departmentId: "",
                        supervisorId: "",
                      }))
                    }
                  >
                    <SelectTrigger
                      id="employee-facility"
                      className="min-h-11"
                      disabled={facilitiesQuery.isLoading}
                    >
                      <SelectValue
                        placeholder={t("employees_page.select_facility")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(facilitiesQuery.data ?? []).map((facility) => (
                        <SelectItem
                          key={facility.id}
                          value={String(facility.id)}
                        >
                          {isRTL ? facility.nameAr : facility.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("employees_page.facility_create_hint")}
                  </p>
                </div>
              )}

              {isInvitationMode ? (
                <div className="space-y-2">
                  <Label>{t("employees_page.role")}</Label>
                  <div className="flex min-h-11 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">
                    {t("roles.employee")}
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("employees_page.invitation_employee_role_hint")}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="employee-role">
                    {t("employees_page.role")}
                  </Label>
                  <Select
                    value={employeeForm.role}
                    onValueChange={(role) => {
                      clearCreateStepUpSecrets();
                      setCreateFeedbackKey(null);
                      setEmployeeForm((previous) => ({ ...previous, role }));
                    }}
                  >
                    <SelectTrigger id="employee-role" className="min-h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {assignableRoles.map((role) => (
                        <SelectItem key={role} value={role}>
                          {t(`roles.${role}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="employee-department">
                  {t("employees_page.department")}
                </Label>
                <Select
                  value={employeeForm.departmentId || "none"}
                  onValueChange={(departmentId) =>
                    setEmployeeForm((previous) => ({
                      ...previous,
                      departmentId: departmentId === "none" ? "" : departmentId,
                    }))
                  }
                >
                  <SelectTrigger
                    id="employee-department"
                    className="min-h-11"
                    disabled={departmentsQuery.isLoading}
                  >
                    <SelectValue
                      placeholder={t("employees_page.no_department")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("employees_page.no_department")}
                    </SelectItem>
                    {departmentOptions.map((department) => (
                      <SelectItem
                        key={department.id}
                        value={String(department.id)}
                      >
                        {isRTL ? department.nameAr : department.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="employee-supervisor">
                  {t("employees_page.supervisor")}
                </Label>
                <Select
                  value={employeeForm.supervisorId || "none"}
                  onValueChange={(supervisorId) =>
                    setEmployeeForm((previous) => ({
                      ...previous,
                      supervisorId: supervisorId === "none" ? "" : supervisorId,
                    }))
                  }
                >
                  <SelectTrigger
                    id="employee-supervisor"
                    className="min-h-11"
                    disabled={managementDirectoryQuery.isLoading}
                  >
                    <SelectValue
                      placeholder={t("employees_page.no_supervisor")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("employees_page.no_supervisor")}
                    </SelectItem>
                    {supervisorOptions.map((supervisor) => (
                      <SelectItem
                        key={supervisor.id}
                        value={String(supervisor.id)}
                      >
                        {getEmployeeDisplayName(supervisor, isRTL)} —{" "}
                        {t(`roles.${supervisor.role}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {dialogRequiresStepUp && (
                <section
                  className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:col-span-2"
                  aria-labelledby="create-step-up-title"
                  aria-describedby="create-step-up-description"
                >
                  <div className="flex items-start gap-3">
                    <ShieldCheck
                      className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <h3 id="create-step-up-title" className="font-semibold">
                        {t("employees_page.step_up_title")}
                      </h3>
                      <p
                        id="create-step-up-description"
                        className="mt-1 text-sm leading-6 text-muted-foreground"
                      >
                        {t(
                          isInvitationMode
                            ? "employees_page.invitation_step_up_hint"
                            : "employees_page.create_step_up_hint",
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="create-step-up-password">
                        {t("twofa.current_password")}
                      </Label>
                      <Input
                        ref={createStepUpPasswordRef}
                        id="create-step-up-password"
                        name={ADMIN_MFA_CURRENT_PASSWORD_FIELD}
                        type="password"
                        dir="ltr"
                        maxLength={1024}
                        autoComplete="current-password"
                        aria-describedby="create-step-up-description"
                        required
                        className="min-h-11"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="create-step-up-code">
                        {t("twofa.code_label")}
                      </Label>
                      <Input
                        ref={createStepUpCodeRef}
                        id="create-step-up-code"
                        name={ADMIN_MFA_CODE_FIELD}
                        type="text"
                        dir="ltr"
                        maxLength={128}
                        inputMode="text"
                        autoComplete="one-time-code"
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-describedby="create-step-up-description"
                        placeholder="123456 / XXXXX-XXXXX"
                        required
                        className="min-h-11 font-mono"
                      />
                    </div>
                  </div>
                </section>
              )}

              {!isInvitationMode ? (
                <div className="space-y-2 sm:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="employee-temporary-password">
                      {t("employees_page.temporary_password")}
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={generatePassword}
                      disabled={employeeActionPending}
                      className="min-h-11 gap-2"
                    >
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                      {t("employees_page.generate_password")}
                    </Button>
                  </div>
                  <div className="relative" dir="ltr">
                    <Input
                      id="employee-temporary-password"
                      type={showTemporaryPassword ? "text" : "password"}
                      minLength={12}
                      maxLength={1024}
                      required
                      autoComplete="new-password"
                      value={employeeForm.password}
                      onChange={(event) => {
                        setEmployeeForm((previous) => ({
                          ...previous,
                          password: event.target.value,
                        }));
                        setPasswordDeliveryAcknowledged(false);
                      }}
                      aria-describedby="employee-temporary-password-hint"
                      dir="ltr"
                      className="min-h-11 pr-12"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-11 w-11"
                      onClick={() =>
                        setShowTemporaryPassword((previous) => !previous)
                      }
                      aria-label={t(
                        showTemporaryPassword
                          ? "employees_page.hide_password"
                          : "employees_page.show_password",
                      )}
                    >
                      {showTemporaryPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                  <p
                    id="employee-temporary-password-hint"
                    className="text-xs leading-5 text-muted-foreground"
                  >
                    {t("employees_page.temporary_password_hint")}
                  </p>
                  <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void copyTemporaryPassword()}
                      disabled={!employeeForm.password || employeeActionPending}
                      className="min-h-11 gap-2"
                    >
                      <Copy className="h-4 w-4" aria-hidden="true" />
                      {t("employees_page.copy_temporary_password")}
                    </Button>
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id="employee-password-delivery-ack"
                        checked={passwordDeliveryAcknowledged}
                        onCheckedChange={(checked) =>
                          setPasswordDeliveryAcknowledged(checked === true)
                        }
                        disabled={
                          !employeeForm.password || employeeActionPending
                        }
                        className="mt-1"
                      />
                      <Label
                        htmlFor="employee-password-delivery-ack"
                        className="cursor-pointer text-xs leading-5 text-muted-foreground"
                      >
                        {t("employees_page.password_delivery_ack")}
                      </Label>
                    </div>
                  </div>
                </div>
              ) : (
                <section className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:col-span-2">
                  <div className="flex items-start gap-3">
                    <MailPlus
                      className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <div>
                      <h3 className="font-semibold">
                        {t("employees_page.invitation_email_title")}
                      </h3>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        {t("employees_page.invitation_email_hint")}
                      </p>
                    </div>
                  </div>
                </section>
              )}
            </div>

            {createFeedbackKey && (
              <p
                className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {t(createFeedbackKey)}
              </p>
            )}

            <DialogFooter className="gap-2 sm:space-x-0">
              <Button
                type="button"
                variant="outline"
                onClick={closeCreateEmployee}
                className="min-h-11 w-full sm:w-auto"
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  employeeActionPending ||
                  (isSystemAdmin && !employeeForm.facilityId) ||
                  (!isInvitationMode &&
                    !isPasswordDeliveryReady(
                      employeeForm.password,
                      passwordDeliveryAcknowledged,
                    ))
                }
                className="min-h-11 w-full gap-2 sm:w-auto"
              >
                {employeeActionPending && (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {t(
                  isInvitationMode
                    ? "employees_page.send_invitation"
                    : "employees_page.create_employee",
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={invitationToRevoke != null}
        onOpenChange={(open) => {
          if (!open) closeRevokeInvitation();
        }}
      >
        <DialogContent
          className="max-h-[90dvh] max-w-md overflow-y-auto"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            revokeStepUpPasswordRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("employees_page.revoke_invitation_title")}
            </DialogTitle>
            <DialogDescription id="revoke-invitation-description">
              {t("employees_page.revoke_invitation_description")}
              {invitationToRevoke && (
                <>
                  {" "}
                  <bdi>
                    {getInvitationDisplayName(invitationToRevoke, isRTL)}
                  </bdi>
                  {" ("}
                  <bdi dir="ltr" className="break-all">
                    {invitationToRevoke.email}
                  </bdi>
                  {")"}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleRevokeInvitation} className="space-y-5">
            <div
              className="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4"
              role="note"
            >
              <MailX
                className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <p className="text-sm leading-6 text-muted-foreground">
                {t("employees_page.revoke_invitation_warning")}
              </p>
            </div>

            <section
              className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4"
              aria-labelledby="revoke-step-up-title"
              aria-describedby="revoke-step-up-description"
            >
              <div className="flex items-start gap-3">
                <ShieldCheck
                  className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <h3 id="revoke-step-up-title" className="font-semibold">
                    {t("employees_page.step_up_title")}
                  </h3>
                  <p
                    id="revoke-step-up-description"
                    className="mt-1 text-sm leading-6 text-muted-foreground"
                  >
                    {t("employees_page.invitation_revoke_step_up_hint")}
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="revoke-step-up-password">
                    {t("twofa.current_password")}
                  </Label>
                  <Input
                    ref={revokeStepUpPasswordRef}
                    id="revoke-step-up-password"
                    name={ADMIN_MFA_CURRENT_PASSWORD_FIELD}
                    type="password"
                    dir="ltr"
                    maxLength={1024}
                    autoComplete="current-password"
                    aria-describedby="revoke-step-up-description"
                    required
                    className="min-h-11"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="revoke-step-up-code">
                    {t("twofa.code_label")}
                  </Label>
                  <Input
                    ref={revokeStepUpCodeRef}
                    id="revoke-step-up-code"
                    name={ADMIN_MFA_CODE_FIELD}
                    type="text"
                    dir="ltr"
                    maxLength={128}
                    inputMode="text"
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-describedby="revoke-step-up-description"
                    placeholder="123456 / XXXXX-XXXXX"
                    required
                    className="min-h-11 font-mono"
                  />
                </div>
              </div>
            </section>

            {revokeFeedbackKey && (
              <p
                className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                role="alert"
              >
                {t(revokeFeedbackKey)}
              </p>
            )}

            <DialogFooter className="gap-2 sm:space-x-0">
              <Button
                type="button"
                variant="outline"
                onClick={closeRevokeInvitation}
                disabled={revokeEmployeeInvitation.isPending}
                className="min-h-11 w-full sm:w-auto"
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={revokeEmployeeInvitation.isPending}
                className="min-h-11 w-full gap-2 sm:w-auto"
              >
                {revokeEmployeeInvitation.isPending && (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {t("employees_page.revoke_invitation")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InvitationCard({
  invitation,
  facilityLabel,
  isRTL,
  t,
  onRevoke,
}: {
  invitation: EmployeeInvitation;
  facilityLabel?: string;
  isRTL: boolean;
  t: Translator;
  onRevoke: () => void;
}) {
  const name = getInvitationDisplayName(invitation, isRTL);
  const jobTitle = isRTL
    ? invitation.jobTitleAr.trim() || invitation.jobTitle.trim()
    : invitation.jobTitle.trim() || invitation.jobTitleAr.trim();
  const headingId = `employee-invitation-${invitation.id}`;

  return (
    <Card
      className="min-w-0 overflow-hidden"
      role="article"
      aria-labelledby={headingId}
    >
      <CardContent className="flex h-full flex-col gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-primary"
            aria-hidden="true"
          >
            {getEmployeeInitial(name)}
          </span>
          <div className="min-w-0 flex-1">
            <h3 id={headingId} className="truncate font-semibold">
              {name}
            </h3>
            <p
              className="mt-1 break-all text-xs text-muted-foreground"
              dir="ltr"
            >
              {invitation.email}
            </p>
          </div>
          <Badge variant="secondary" className="shrink-0">
            {t("roles.employee")}
          </Badge>
        </div>

        <dl className="grid grid-cols-1 gap-3 rounded-lg bg-muted/40 p-3 text-sm min-[360px]:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {t("employees_page.employee_number")}
            </dt>
            <dd className="mt-1 truncate font-medium" dir="auto">
              {invitation.employeeNumber}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {t("employees_page.job_title")}
            </dt>
            <dd className="mt-1 truncate font-medium" dir="auto">
              {jobTitle}
            </dd>
          </div>
          {facilityLabel && (
            <div className="min-w-0 min-[360px]:col-span-2">
              <dt className="text-xs text-muted-foreground">
                {t("employees_page.facility")}
              </dt>
              <dd className="mt-1 truncate font-medium" dir="auto">
                {facilityLabel}
              </dd>
            </div>
          )}
          <div className="min-w-0 min-[360px]:col-span-2">
            <dt className="text-xs text-muted-foreground">
              {t("employees_page.invitation_expires")}
            </dt>
            <dd className="mt-1 font-medium">
              <time dateTime={invitation.expiresAt}>
                {formatInvitationDate(invitation.expiresAt, isRTL)}
              </time>
            </dd>
          </div>
        </dl>

        <Button
          type="button"
          variant="outline"
          onClick={onRevoke}
          className="mt-auto min-h-11 w-full gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          aria-label={`${t("employees_page.revoke_invitation")}: ${name}`}
        >
          <MailX className="h-4 w-4" aria-hidden="true" />
          {t("employees_page.revoke_invitation")}
        </Button>
      </CardContent>
    </Card>
  );
}

function formatInvitationDate(value: string, isRTL: boolean): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(isRTL ? "ar-SA" : "en-SA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function EmployeeMobileCard({ employee, isRTL, t }: EmployeeItemProps) {
  const name = getEmployeeDisplayName(employee, isRTL);
  const complianceRate = getComplianceRate(employee.complianceRate);

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardContent className="space-y-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <EmployeeAvatar name={name} />
          <div className="min-w-0 flex-1">
            <Link
              href={`/employees/${employee.id}`}
              className="inline-flex min-h-11 max-w-full items-center rounded-md font-semibold text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span className="truncate">{name}</span>
            </Link>
            <p className="truncate text-xs text-muted-foreground" dir="auto">
              {employee.employeeNumber || employee.email}
            </p>
          </div>
          <ComplianceBadge employee={employee} t={t} />
        </div>

        <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3 text-sm">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {t("employees_page.role")}
            </dt>
            <dd className="mt-1 truncate font-medium">
              {t(`roles.${employee.role}`)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {t("employees_page.compliance")}
            </dt>
            <dd className="mt-1 font-semibold tabular-nums">
              {complianceRate}%
            </dd>
          </div>
        </dl>

        <ProgressBar
          name={name}
          rate={complianceRate}
          label={t("employees_page.compliance")}
        />

        <Button asChild variant="outline" className="min-h-11 w-full">
          <Link href={`/employees/${employee.id}`}>
            {t("employees_page.view_profile")}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function EmployeeTableRow({ employee, isRTL, t }: EmployeeItemProps) {
  const name = getEmployeeDisplayName(employee, isRTL);
  const complianceRate = getComplianceRate(employee.complianceRate);

  return (
    <tr className="transition-colors hover:bg-muted/30">
      <td className="px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <EmployeeAvatar name={name} />
          <div className="min-w-0">
            <Link
              href={`/employees/${employee.id}`}
              className="rounded-sm font-semibold text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {name}
            </Link>
            <div
              className="max-w-56 truncate text-xs text-muted-foreground"
              dir="auto"
            >
              {employee.employeeNumber || employee.email}
            </div>
          </div>
        </div>
      </td>
      <td className="px-5 py-4 text-muted-foreground">
        {t(`roles.${employee.role}`)}
      </td>
      <td className="px-5 py-4">
        <ComplianceBadge employee={employee} t={t} />
      </td>
      <td className="w-52 px-5 py-4">
        <div className="flex items-center gap-3">
          <ProgressBar
            name={name}
            rate={complianceRate}
            label={t("employees_page.compliance")}
          />
          <span className="w-10 text-end text-xs font-medium tabular-nums">
            {complianceRate}%
          </span>
        </div>
      </td>
      <td className="px-5 py-4 text-end">
        <Button asChild variant="ghost" className="min-h-11">
          <Link href={`/employees/${employee.id}`}>{t("common.view")}</Link>
        </Button>
      </td>
    </tr>
  );
}

function EmployeeAvatar({ name }: { name: string }) {
  return (
    <span
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-primary"
      aria-hidden="true"
    >
      {getEmployeeInitial(name)}
    </span>
  );
}

function ComplianceBadge({
  employee,
  t,
}: {
  employee: EmployeeWithStats;
  t: Translator;
}) {
  return employee.isAtRisk ? (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 border-0 bg-destructive/10 text-destructive"
    >
      <AlertCircle className="h-3 w-3" aria-hidden="true" />
      {t("employees_page.at_risk")}
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="shrink-0 border-0 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
    >
      {t("employees_page.compliant")}
    </Badge>
  );
}

function ProgressBar({
  name,
  rate,
  label,
}: {
  name: string;
  rate: number;
  label: string;
}) {
  return (
    <Progress
      value={rate}
      aria-label={`${label}: ${name}`}
      className="h-2 min-w-0 flex-1"
      indicatorClassName={cn(
        rate >= 90
          ? "bg-emerald-500"
          : rate >= 70
            ? "bg-amber-500"
            : "bg-destructive",
      )}
    />
  );
}

function EmployeeListSkeleton({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="grid gap-3" role="status">
      <span className="sr-only">{loadingLabel}</span>
      {Array.from({ length: 5 }).map((_, index) => (
        <Skeleton key={index} className="h-44 w-full rounded-xl md:h-20" />
      ))}
    </div>
  );
}

function EmployeeFormField({
  id,
  label,
  value,
  onChange,
  type = "text",
  dir,
  required = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel";
  dir: "rtl" | "ltr";
  required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        dir={dir}
        className="min-h-11"
      />
    </div>
  );
}

function createEmptyEmployeeForm(facilityId?: number): EmployeeAccountForm {
  return {
    name: "",
    nameAr: "",
    email: "",
    password: "",
    role: "employee",
    departmentId: "",
    supervisorId: "",
    facilityId: facilityId == null ? "" : String(facilityId),
    jobTitle: "",
    jobTitleAr: "",
    employeeNumber: "",
    phone: "",
  };
}

type Translator = (key: string) => string;

type EmployeeItemProps = {
  employee: EmployeeWithStats;
  isRTL: boolean;
  t: Translator;
};
