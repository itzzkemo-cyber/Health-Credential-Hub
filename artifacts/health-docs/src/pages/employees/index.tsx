import { useDeferredValue, useRef, useState } from "react";
import {
  ApiError,
  type EmployeeWithStats,
  getGetFacilitiesQueryKey,
  useGetFacilities,
  getListDepartmentsQueryKey,
  getListEmployeesQueryKey,
  useCreateEmployee,
  useListDepartments,
  useListEmployees,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertCircle,
  Copy,
  Eye,
  EyeOff,
  HeartPulse,
  KeyRound,
  Loader2,
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
  generateTemporaryPassword,
  type EmployeeAccountForm,
  getComplianceRate,
  getDepartmentOptions,
  getEmployeeDisplayName,
  getEmployeeInitial,
  getSupervisorOptions,
  getAssignableRoles,
  isPasswordDeliveryReady,
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
  const [showTemporaryPassword, setShowTemporaryPassword] = useState(false);
  const [passwordDeliveryAcknowledged, setPasswordDeliveryAcknowledged] =
    useState(false);
  const [createFeedbackKey, setCreateFeedbackKey] = useState<string | null>(
    null,
  );
  const createStepUpPasswordRef = useRef<HTMLInputElement>(null);
  const createStepUpCodeRef = useRef<HTMLInputElement>(null);
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
      enabled: isSystemAdmin && isCreateOpen,
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
  const employees = employeesQuery.data ?? [];
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

  const clearCreateStepUpSecrets = () => {
    if (createStepUpPasswordRef.current) {
      createStepUpPasswordRef.current.value = "";
    }
    if (createStepUpCodeRef.current) createStepUpCodeRef.current.value = "";
  };

  const resetCreateEmployeeForm = () => {
    clearCreateStepUpSecrets();
    createEmployee.reset();
    setEmployeeForm(
      createEmptyEmployeeForm(isSystemAdmin ? user?.facilityId : undefined),
    );
    setShowTemporaryPassword(false);
    setPasswordDeliveryAcknowledged(false);
    setCreateFeedbackKey(null);
  };

  const openCreateEmployee = () => {
    resetCreateEmployeeForm();
    setIsCreateOpen(true);
  };

  const closeCreateEmployee = () => {
    if (createEmployee.isPending) return;
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
      !isPasswordDeliveryReady(
        employeeForm.password,
        passwordDeliveryAcknowledged,
      )
    ) {
      return;
    }

    setCreateFeedbackKey(null);
    const form = event.currentTarget;
    const stepUp = createRequiresStepUp
      ? readAdminMfaStepUpCredentials(new FormData(form))
      : undefined;
    if (createRequiresStepUp && !stepUp) {
      setCreateFeedbackKey("employees_page.step_up_required");
      createStepUpPasswordRef.current?.focus();
      return;
    }

    createEmployee.mutate(
      {
        data: buildEmployeeInput(employeeForm, stepUp ?? undefined),
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
          <Button
            type="button"
            onClick={openCreateEmployee}
            className="min-h-11 w-full gap-2 sm:w-auto"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("employees_page.add_employee")}
          </Button>
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
            <DialogTitle>{t("employees_page.add_employee")}</DialogTitle>
            <DialogDescription>
              {t("employees_page.add_employee_description")}
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

              {createRequiresStepUp && (
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
                        {t("employees_page.create_step_up_hint")}
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

              <div className="space-y-2 sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="employee-temporary-password">
                    {t("employees_page.temporary_password")}
                  </Label>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={generatePassword}
                    disabled={createEmployee.isPending}
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
                    disabled={
                      !employeeForm.password || createEmployee.isPending
                    }
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
                        !employeeForm.password || createEmployee.isPending
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
                  createEmployee.isPending ||
                  (isSystemAdmin && !employeeForm.facilityId) ||
                  !isPasswordDeliveryReady(
                    employeeForm.password,
                    passwordDeliveryAcknowledged,
                  )
                }
                className="min-h-11 w-full gap-2 sm:w-auto"
              >
                {createEmployee.isPending && (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {t("employees_page.create_employee")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email";
  dir: "rtl" | "ltr";
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        required
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
  };
}

type Translator = (key: string) => string;

type EmployeeItemProps = {
  employee: EmployeeWithStats;
  isRTL: boolean;
  t: Translator;
};
