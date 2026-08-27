import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetFacilitiesQueryKey,
  getGetEmployeeQueryKey,
  getListDepartmentsQueryKey,
  getListEmployeesQueryKey,
  useActivateEmployee,
  useDeactivateEmployee,
  useGetEmployee,
  useGetFacilities,
  useListDepartments,
  useListEmployees,
  useTotpAdminDisable,
  useUpdateEmployee,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Building2,
  FileText,
  Loader2,
  Mail,
  Pencil,
  Phone,
  Power,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import {
  buildEmployeeUpdate,
  canEditOrganizationalFields,
  createEmployeeEditForm,
  type EmployeeEditForm,
  getAssignableRoles,
  getDepartmentOptions,
  getEmployeeDisplayName,
  getSupervisorOptions,
} from "./employee-list-state";
import { getDepartmentQueryParams } from "./department-query";

const ADMIN_ROLES = ["hospital_admin", "system_admin"];

export default function EmployeeDetail() {
  const { t, isRTL } = useLanguage();
  const [, params] = useRoute("/employees/:id");
  const [, setLocation] = useLocation();
  const id = Number(params?.id);
  const queryClient = useQueryClient();
  const me = getAuthUser() as {
    id?: number;
    role?: string;
    facilityId?: number;
  } | null;
  const isAdmin = !!me?.role && ADMIN_ROLES.includes(me.role);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<EmployeeEditForm | null>(null);

  const employeeQuery = useGetEmployee(id);
  const emp = employeeQuery.data;
  const facilitiesQuery = useGetFacilities({
    query: { queryKey: getGetFacilitiesQueryKey(), enabled: isAdmin },
  });
  const departmentDirectoryParams = getDepartmentQueryParams(
    me?.role,
    emp?.facilityId,
  );
  const departmentsQuery = useListDepartments(departmentDirectoryParams, {
    query: {
      queryKey: getListDepartmentsQueryKey(departmentDirectoryParams),
      enabled: isAdmin && isEditOpen,
    },
  });
  const managementDirectoryParams =
    emp?.facilityId == null ? undefined : { facilityId: emp.facilityId };
  const managementDirectoryQuery = useListEmployees(managementDirectoryParams, {
    query: {
      queryKey: getListEmployeesQueryKey(managementDirectoryParams),
      enabled: isAdmin && isEditOpen && emp != null,
    },
  });
  const updateEmployee = useUpdateEmployee();
  const activateEmployee = useActivateEmployee();
  const deactivateEmployee = useDeactivateEmployee();
  const adminDisableMutation = useTotpAdminDisable();

  const actor = me?.id != null && me.role ? { id: me.id, role: me.role } : null;
  const organizationEditable =
    actor != null && emp != null
      ? canEditOrganizationalFields(actor, emp)
      : false;
  const isOwnAccount = emp != null && me?.id === emp.id;
  const canEditProfile =
    isAdmin && emp != null && (isOwnAccount || organizationEditable);
  const canChangeActivation = isAdmin && organizationEditable;
  const managementDirectory = managementDirectoryQuery.data ?? [];
  const departmentOptions = emp
    ? getDepartmentOptions(
        departmentsQuery.data ?? [],
        managementDirectory,
        emp.facilityId,
      )
    : [];
  const supervisorOptions = emp
    ? getSupervisorOptions(managementDirectory, emp.id, emp.facilityId)
    : [];
  const assignableRoles = emp
    ? [...new Set([emp.role, ...getAssignableRoles(me?.role ?? "")])]
    : [];
  const facility = facilitiesQuery.data?.find(
    (candidate) => candidate.id === emp?.facilityId,
  );

  const invalidateEmployeeQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetEmployeeQueryKey(id) }),
      queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey() }),
    ]);
  };

  const openEdit = () => {
    if (!emp) return;
    updateEmployee.reset();
    setEditForm(createEmployeeEditForm(emp));
    setIsEditOpen(true);
  };

  const handleUpdate = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editForm || !emp) return;
    updateEmployee.mutate(
      {
        id: emp.id,
        data: buildEmployeeUpdate(editForm, organizationEditable),
      },
      {
        onSuccess: async () => {
          await invalidateEmployeeQueries();
          setIsEditOpen(false);
          toast.success(t("employees_page.update_success"));
        },
        onError: () => toast.error(t("employees_page.update_failed")),
      },
    );
  };

  const handleAccountStateChange = () => {
    if (!emp || !canChangeActivation) return;
    const mutation = emp.isActive ? deactivateEmployee : activateEmployee;
    mutation.mutate(
      { id: emp.id },
      {
        onSuccess: async () => {
          await invalidateEmployeeQueries();
          toast.success(
            t(
              emp.isActive
                ? "employees_page.deactivate_success"
                : "employees_page.activate_success",
            ),
          );
        },
        onError: () => toast.error(t("employees_page.account_state_failed")),
      },
    );
  };

  const handleAdminDisable = () => {
    adminDisableMutation.mutate(
      { data: { userId: id } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: getGetEmployeeQueryKey(id),
          });
          toast.success(t("twofa.admin_disabled_success"));
        },
        onError: () => toast.error(t("twofa.invalid_code")),
      },
    );
  };

  if (employeeQuery.isLoading) {
    return (
      <div className="space-y-6" role="status">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (employeeQuery.isError || !emp) {
    return (
      <div className="p-8 text-center text-destructive" role="alert">
        {t("employees_page.load_error")}
      </div>
    );
  }

  const employeeName = getEmployeeDisplayName(emp, isRTL);
  const accountMutationPending =
    activateEmployee.isPending || deactivateEmployee.isPending;

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12 animate-in fade-in duration-500 sm:space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/employees")}
            aria-label={t("common.back")}
            className="h-11 w-11 shrink-0"
          >
            {isRTL ? (
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            ) : (
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            )}
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">
              {t("employees_page.profile")}
            </h1>
            <p className="truncate text-sm text-muted-foreground">
              {employeeName}
            </p>
          </div>
        </div>

        {canEditProfile && (
          <div className="grid grid-cols-1 gap-2 sm:flex">
            <Button
              type="button"
              variant="outline"
              onClick={openEdit}
              className="min-h-11 gap-2"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {t("employees_page.edit_account")}
            </Button>
            {canChangeActivation && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant={emp.isActive ? "destructive" : "default"}
                    disabled={accountMutationPending}
                    className="min-h-11 gap-2"
                  >
                    {accountMutationPending ? (
                      <Loader2
                        className="h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Power className="h-4 w-4" aria-hidden="true" />
                    )}
                    {t(
                      emp.isActive
                        ? "employees_page.deactivate_account"
                        : "employees_page.activate_account",
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t(
                        emp.isActive
                          ? "employees_page.deactivate_confirm_title"
                          : "employees_page.activate_confirm_title",
                      )}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(
                        emp.isActive
                          ? "employees_page.deactivate_confirm_description"
                          : "employees_page.activate_confirm_description",
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleAccountStateChange}
                      className={
                        emp.isActive
                          ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          : undefined
                      }
                    >
                      {t("common.confirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        <div className="space-y-6">
          <Card className="overflow-hidden border-t-4 border-t-primary hover-elevate">
            <CardContent className="p-5 sm:p-6">
              <div className="flex flex-col items-center border-b border-border pb-6 text-center">
                <div className="mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-primary/10 text-3xl font-bold text-primary">
                  {Array.from(employeeName)[0] ?? "•"}
                </div>
                <h2 className="break-words text-xl font-bold">
                  {employeeName}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(`roles.${emp.role}`)}
                </p>
                <Badge
                  variant="outline"
                  className={
                    emp.isActive
                      ? "mt-3 border-0 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : "mt-3 border-0 bg-muted text-muted-foreground"
                  }
                >
                  {t(
                    emp.isActive
                      ? "employees_page.account_active"
                      : "employees_page.account_inactive",
                  )}
                </Badge>
                {emp.isAtRisk && (
                  <Badge variant="destructive" className="mt-3 gap-1">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    {t("employees_page.at_risk")}
                  </Badge>
                )}
              </div>

              <div className="space-y-4 border-b border-border py-6">
                <ProfileRow icon={Mail} dir="ltr">
                  {emp.email}
                </ProfileRow>
                {emp.phone && <ProfileRow icon={Phone}>{emp.phone}</ProfileRow>}
                <ProfileRow icon={Briefcase}>
                  {(isRTL ? emp.jobTitleAr : emp.jobTitle) ||
                    emp.employeeNumber ||
                    t("employees_page.not_available")}
                </ProfileRow>
                <ProfileRow icon={Building2}>
                  {facility
                    ? isRTL
                      ? facility.nameAr
                      : facility.name
                    : `${t("employees_page.facility")} #${emp.facilityId}`}
                </ProfileRow>
                {emp.department && (
                  <ProfileRow icon={Building2}>
                    {isRTL ? emp.department.nameAr : emp.department.name}
                  </ProfileRow>
                )}
                {emp.supervisor && (
                  <ProfileRow icon={ShieldCheck}>
                    {t("employees_page.supervisor")}:{" "}
                    {isRTL ? emp.supervisor.nameAr : emp.supervisor.name}
                  </ProfileRow>
                )}
                {emp.totpEnabled && (
                  <ProfileRow icon={ShieldCheck} emphasize>
                    {t("twofa.admin_badge")}
                  </ProfileRow>
                )}
              </div>

              {emp.totpEnabled && isAdmin && !isOwnAccount && (
                <div className="border-b border-border py-6">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11 w-full border-destructive/40 text-destructive hover:bg-destructive/10"
                        disabled={adminDisableMutation.isPending}
                      >
                        {t("twofa.admin_disable")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("twofa.admin_disable")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("twofa.admin_disable_hint")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t("common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={handleAdminDisable}
                        >
                          {t("twofa.admin_disable_confirm")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}

              <div className="pt-6">
                <p className="mb-3 text-sm font-medium">
                  {t("employees_page.overall_compliance")}
                </p>
                <span className="mb-1 block text-2xl font-bold">
                  {emp.complianceRate || 0}%
                </span>
                <Progress
                  value={emp.complianceRate || 0}
                  aria-label={t("employees_page.overall_compliance")}
                  className="h-3"
                  indicatorClassName={getComplianceColor(
                    emp.complianceRate || 0,
                  )}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card className="hover-elevate">
            <CardHeader className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <CardTitle>{t("employees_page.credentials")}</CardTitle>
              <Button
                size="sm"
                onClick={() =>
                  setLocation(`/credentials/new?employeeId=${emp.id}`)
                }
                className="min-h-11 w-full gap-2 sm:w-auto"
              >
                <PlusIcon className="h-4 w-4" aria-hidden="true" />
                {t("common.add")}
              </Button>
            </CardHeader>
            <CardContent>
              {emp.missingCredentials && emp.missingCredentials.length > 0 && (
                <div className="mb-6 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                    <div>
                      <h3 className="text-sm font-semibold text-destructive">
                        {t("employees_page.missing_required")}
                      </h3>
                      <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-destructive/80">
                        {emp.missingCredentials.map((credential) => (
                          <li key={credential}>{credential}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {emp.credentials?.length ? (
                  emp.credentials.map((credential) => (
                    <div
                      key={credential.id}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/30 sm:flex-nowrap"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <div className="shrink-0 rounded-md bg-primary/10 p-2">
                          <FileText className="h-5 w-5 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <Link
                            href={`/credentials/${credential.id}`}
                            className="inline-flex min-h-11 max-w-full items-center rounded-sm font-medium transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          >
                            <span className="truncate">
                              {isRTL
                                ? credential.customTypeNameAr || credential.type
                                : credential.customTypeName || credential.type}
                            </span>
                          </Link>
                          <div className="text-xs text-muted-foreground">
                            {t("employees_page.expires")}:{" "}
                            {new Date(credential.expiryDate).toLocaleDateString(
                              isRTL ? "ar-SA" : "en-US",
                            )}
                          </div>
                        </div>
                      </div>
                      <Badge
                        className={`${getStatusColor(credential.status)} shrink-0`}
                        variant="outline"
                      >
                        {t(`common.${credential.status}`)}
                      </Badge>
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed py-8 text-center text-muted-foreground">
                    {t("employees_page.no_active_credentials")}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={isEditOpen}
        onOpenChange={(open) => {
          setIsEditOpen(open);
          if (!open) {
            updateEmployee.reset();
            setEditForm(null);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("employees_page.edit_account")}</DialogTitle>
            <DialogDescription>
              {t("employees_page.edit_account_description")}
            </DialogDescription>
          </DialogHeader>
          {editForm && (
            <form onSubmit={handleUpdate} className="space-y-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <EditField
                  id="edit-name-en"
                  label={t("employees_page.name_english")}
                  value={editForm.name}
                  onChange={(name) =>
                    setEditForm((previous) =>
                      previous ? { ...previous, name } : previous,
                    )
                  }
                  dir="ltr"
                />
                <EditField
                  id="edit-name-ar"
                  label={t("employees_page.name_arabic")}
                  value={editForm.nameAr}
                  onChange={(nameAr) =>
                    setEditForm((previous) =>
                      previous ? { ...previous, nameAr } : previous,
                    )
                  }
                  dir="rtl"
                />
                <EditField
                  id="edit-job-title-en"
                  label={t("employees_page.job_title_english")}
                  value={editForm.jobTitle}
                  onChange={(jobTitle) =>
                    setEditForm((previous) =>
                      previous ? { ...previous, jobTitle } : previous,
                    )
                  }
                  dir="ltr"
                />
                <EditField
                  id="edit-job-title-ar"
                  label={t("employees_page.job_title_arabic")}
                  value={editForm.jobTitleAr}
                  onChange={(jobTitleAr) =>
                    setEditForm((previous) =>
                      previous ? { ...previous, jobTitleAr } : previous,
                    )
                  }
                  dir="rtl"
                />
                <EditField
                  id="edit-phone"
                  label={t("employees_page.phone")}
                  value={editForm.phone}
                  onChange={(phone) =>
                    setEditForm((previous) =>
                      previous ? { ...previous, phone } : previous,
                    )
                  }
                  dir="ltr"
                  required={false}
                />

                <div className="space-y-2">
                  <Label htmlFor="edit-facility">
                    {t("employees_page.facility")}
                  </Label>
                  <Input
                    id="edit-facility"
                    value={
                      facility
                        ? isRTL
                          ? facility.nameAr
                          : facility.name
                        : `#${emp.facilityId}`
                    }
                    readOnly
                    disabled
                    className="min-h-11"
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("employees_page.facility_read_only_hint")}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="edit-role">{t("employees_page.role")}</Label>
                  <Select
                    value={editForm.role}
                    disabled={!organizationEditable}
                    onValueChange={(role) =>
                      setEditForm((previous) =>
                        previous ? { ...previous, role } : previous,
                      )
                    }
                  >
                    <SelectTrigger id="edit-role" className="min-h-11">
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
                  <Label htmlFor="edit-department">
                    {t("employees_page.department")}
                  </Label>
                  <Select
                    value={editForm.departmentId || "none"}
                    disabled={!organizationEditable}
                    onValueChange={(departmentId) =>
                      setEditForm((previous) =>
                        previous
                          ? {
                              ...previous,
                              departmentId:
                                departmentId === "none" ? "" : departmentId,
                            }
                          : previous,
                      )
                    }
                  >
                    <SelectTrigger id="edit-department" className="min-h-11">
                      <SelectValue />
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

                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="edit-supervisor">
                    {t("employees_page.supervisor")}
                  </Label>
                  <Select
                    value={editForm.supervisorId || "none"}
                    disabled={!organizationEditable}
                    onValueChange={(supervisorId) =>
                      setEditForm((previous) =>
                        previous
                          ? {
                              ...previous,
                              supervisorId:
                                supervisorId === "none" ? "" : supervisorId,
                            }
                          : previous,
                      )
                    }
                  >
                    <SelectTrigger id="edit-supervisor" className="min-h-11">
                      <SelectValue />
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
              </div>

              {!organizationEditable && (
                <p className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  {t(
                    isOwnAccount
                      ? "employees_page.self_scope_locked"
                      : "employees_page.hierarchy_scope_locked",
                  )}
                </p>
              )}

              {updateEmployee.isError && (
                <p
                  className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
                  role="alert"
                >
                  {t(
                    updateEmployee.error instanceof ApiError &&
                      updateEmployee.error.status === 403
                      ? "employees_page.update_forbidden"
                      : "employees_page.update_failed",
                  )}
                </p>
              )}

              <DialogFooter className="gap-2 sm:space-x-0">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsEditOpen(false)}
                  className="min-h-11 w-full sm:w-auto"
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    updateEmployee.isPending ||
                    !editForm.name.trim() ||
                    !editForm.nameAr.trim()
                  }
                  className="min-h-11 w-full gap-2 sm:w-auto"
                >
                  {updateEmployee.isPending && (
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {t("employees_page.save_account")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProfileRow({
  icon: Icon,
  children,
  dir,
  emphasize = false,
}: {
  icon: typeof Mail;
  children: React.ReactNode;
  dir?: "ltr" | "rtl";
  emphasize?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-3 text-sm ${
        emphasize
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-muted-foreground"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words" dir={dir}>
        {children}
      </span>
    </div>
  );
}

function EditField({
  id,
  label,
  value,
  onChange,
  dir,
  required = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  dir: "ltr" | "rtl";
  required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        dir={dir}
        required={required}
        className="min-h-11"
      />
    </div>
  );
}

function getComplianceColor(rate: number) {
  if (rate >= 90) return "bg-emerald-500";
  if (rate >= 70) return "bg-amber-500";
  return "bg-destructive";
}

function getStatusColor(status: string) {
  switch (status) {
    case "active":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
    case "expiring_soon":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400";
    case "expired":
      return "bg-destructive/10 text-destructive dark:bg-destructive/20";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function PlusIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}
