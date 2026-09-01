import { useMemo, useState } from "react";
import {
  type DepartmentWithStats,
  getListDepartmentsQueryKey,
  useBatchCreateDepartments,
  useCreateDepartment,
  useDeleteDepartment,
  useListDepartments,
  useUpdateDepartment,
} from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { getAuthUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Activity,
  AlertTriangle,
  Building2,
  Edit,
  ListPlus,
  Loader2,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  getDepartmentPresetRows,
  getMissingDepartmentPresets,
  type DepartmentPresetRow,
} from "./department-presets";

interface DepartmentPresetListProps {
  rows: readonly DepartmentPresetRow[];
  listLabel: string;
  existingLabel: string;
}

export function DepartmentPresetList({
  rows,
  listLabel,
  existingLabel,
}: DepartmentPresetListProps) {
  return (
    <ul
      className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-3"
      aria-label={listLabel}
    >
      {rows.map(({ preset, isExisting }) => (
        <li
          key={preset.name}
          className="flex min-h-11 items-center justify-between gap-1 rounded-md bg-muted/50 px-3 py-2"
        >
          <code className="font-sans font-semibold" dir="ltr">
            {preset.name}
          </code>
          {isExisting && (
            <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
              {existingLabel}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function Departments() {
  const { t, language, isRTL } = useLanguage();
  const queryClient = useQueryClient();
  const user = getAuthUser();
  const isAdmin =
    user?.role === "hospital_admin" || user?.role === "system_admin";

  const { data: departments, isLoading } = useListDepartments();

  const createDept = useCreateDepartment();
  const batchCreateDepartments = useBatchCreateDepartments();
  const updateDept = useUpdateDepartment();
  const deleteDept = useDeleteDepartment();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isPresetOpen, setIsPresetOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selectedDept, setSelectedDept] = useState<DepartmentWithStats | null>(
    null,
  );

  const [formData, setFormData] = useState({ name: "", nameAr: "" });

  const presetRows = useMemo(
    () => getDepartmentPresetRows(departments),
    [departments],
  );
  const missingPresets = useMemo(
    () => getMissingDepartmentPresets(departments),
    [departments],
  );

  const handleOpenCreate = () => {
    setFormData({ name: "", nameAr: "" });
    setIsCreateOpen(true);
  };

  const handleOpenEdit = (dept: DepartmentWithStats) => {
    setSelectedDept(dept);
    setFormData({ name: dept.name, nameAr: dept.nameAr || "" });
    setIsEditOpen(true);
  };

  const handleOpenDelete = (dept: DepartmentWithStats) => {
    setSelectedDept(dept);
    setIsDeleteOpen(true);
  };

  const handlePresetCreate = () => {
    if (missingPresets.length === 0 || batchCreateDepartments.isPending) return;

    batchCreateDepartments.mutate(
      { data: { departments: missingPresets } },
      {
        onSuccess: (result) => {
          void queryClient.invalidateQueries({
            queryKey: getListDepartmentsQueryKey(),
          });
          setIsPresetOpen(false);

          if (result.created.length === 0) {
            toast.success(t("departments.preset_all_existing"));
            return;
          }

          const resultSummary = [
            `${t("departments.preset_created_count")}: ${result.created.length}`,
          ];
          if (result.skipped.length > 0) {
            resultSummary.push(
              `${t("departments.preset_skipped_count")}: ${result.skipped.length}`,
            );
          }
          toast.success(resultSummary.join(" · "));
        },
        onError: () => {
          toast.error(t("departments.preset_error"));
        },
      },
    );
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createDept.mutate(
      { data: formData },
      {
        onSuccess: () => {
          toast.success(t("departments.create_success"));
          setIsCreateOpen(false);
          queryClient.invalidateQueries({
            queryKey: getListDepartmentsQueryKey(),
          });
        },
      },
    );
  };

  const handleEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDept) return;
    updateDept.mutate(
      { id: selectedDept.id, data: formData },
      {
        onSuccess: () => {
          toast.success(t("departments.update_success"));
          setIsEditOpen(false);
          queryClient.invalidateQueries({
            queryKey: getListDepartmentsQueryKey(),
          });
        },
      },
    );
  };

  const handleDelete = () => {
    if (!selectedDept) return;
    deleteDept.mutate(
      { id: selectedDept.id },
      {
        onSuccess: () => {
          toast.success(t("departments.delete_success"));
          setIsDeleteOpen(false);
          queryClient.invalidateQueries({
            queryKey: getListDepartmentsQueryKey(),
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6" dir={isRTL ? "rtl" : "ltr"}>
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {t("departments.title")}
          </h1>
          <p className="text-muted-foreground">{t("departments.subtitle")}</p>
        </div>
        {isAdmin && (
          <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-2"
              onClick={() => setIsPresetOpen(true)}
            >
              <ListPlus className="h-4 w-4" aria-hidden="true" />
              {t("departments.preset_add")}
            </Button>
            <Button
              type="button"
              onClick={handleOpenCreate}
              className="min-h-11 gap-2"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("departments.add")}
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="h-24 bg-muted/50 rounded-t-xl" />
              <CardContent className="h-32" />
            </Card>
          ))}
        </div>
      ) : departments?.length === 0 ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <div className="h-16 w-16 bg-muted rounded-full flex items-center justify-center text-muted-foreground mb-4">
            <Building2 className="h-8 w-8" />
          </div>
          <h3 className="text-lg font-semibold">
            {t("departments.no_departments")}
          </h3>
          {isAdmin && (
            <Button
              onClick={handleOpenCreate}
              variant="outline"
              className="mt-4 gap-2"
            >
              <Plus className="h-4 w-4" />
              {t("departments.add")}
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {departments?.map((dept) => (
            <Card
              key={dept.id}
              className="overflow-hidden hover-elevate transition-all border-border/50"
            >
              <div className="p-6 pb-4 border-b bg-muted/20 flex justify-between items-start">
                <div className="space-y-1">
                  <h3 className="font-bold text-xl">
                    {language === "en" && dept.name ? dept.name : dept.nameAr}
                  </h3>
                </div>
                {isAdmin && (
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 min-h-11 min-w-11 text-muted-foreground hover:text-primary"
                      aria-label={`${t("departments.edit")}: ${language === "en" ? dept.name : dept.nameAr}`}
                      onClick={() => handleOpenEdit(dept)}
                    >
                      <Edit className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 min-h-11 min-w-11 text-muted-foreground hover:text-destructive"
                      aria-label={`${t("departments.delete")}: ${language === "en" ? dept.name : dept.nameAr}`}
                      onClick={() => handleOpenDelete(dept)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </div>
              <CardContent className="p-6 pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="h-4 w-4" />
                    <span className="text-sm">
                      {t("departments.employee_count")}
                    </span>
                  </div>
                  <span className="font-semibold text-lg">
                    {dept.employeeCount}
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Activity className="h-4 w-4" />
                      <span>{t("departments.compliance")}</span>
                    </div>
                    <span className="font-semibold">
                      {dept.complianceRate}%
                    </span>
                  </div>
                  <Progress value={dept.complianceRate} className="h-2" />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t">
                  <div className="flex flex-col gap-1 p-2 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <AlertTriangle className="h-3 w-3" />
                      {t("common.expired")}
                    </div>
                    <span className="text-lg font-bold">
                      {dept.expiredCount}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 p-2 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <Activity className="h-3 w-3" />
                      {t("common.expiring_soon")}
                    </div>
                    <span className="text-lg font-bold">
                      {dept.expiringCount}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isPresetOpen} onOpenChange={setIsPresetOpen}>
        <DialogContent className="w-[calc(100%_-_1.5rem)] max-w-md p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>{t("departments.preset_title")}</DialogTitle>
            <DialogDescription>
              {t("departments.preset_description")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div
              className="flex min-h-11 items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-sm"
              aria-live="polite"
            >
              <span>{t("departments.preset_missing_count")}</span>
              <Badge
                variant={missingPresets.length > 0 ? "default" : "secondary"}
              >
                {missingPresets.length}
              </Badge>
            </div>

            <DepartmentPresetList
              rows={presetRows}
              listLabel={t("departments.preset_codes_label")}
              existingLabel={t("departments.preset_existing")}
            />

            {missingPresets.length === 0 && (
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
                {t("departments.preset_all_existing")}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setIsPresetOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className="min-h-11 gap-2"
              disabled={
                missingPresets.length === 0 || batchCreateDepartments.isPending
              }
              onClick={handlePresetCreate}
            >
              {batchCreateDepartments.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {batchCreateDepartments.isPending
                ? t("departments.preset_adding")
                : t("departments.preset_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>{t("departments.add")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="department-create-name-ar">
                  {t("departments.name")}
                </Label>
                <Input
                  id="department-create-name-ar"
                  required
                  maxLength={120}
                  value={formData.nameAr}
                  onChange={(e) =>
                    setFormData({ ...formData, nameAr: e.target.value })
                  }
                  dir="rtl"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="department-create-name">
                  {t("departments.name_en")}
                </Label>
                <Input
                  id="department-create-name"
                  required
                  maxLength={120}
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  dir="ltr"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setIsCreateOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={createDept.isPending}
              >
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <form onSubmit={handleEdit}>
            <DialogHeader>
              <DialogTitle>{t("departments.edit")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="department-edit-name-ar">
                  {t("departments.name")}
                </Label>
                <Input
                  id="department-edit-name-ar"
                  required
                  maxLength={120}
                  value={formData.nameAr}
                  onChange={(e) =>
                    setFormData({ ...formData, nameAr: e.target.value })
                  }
                  dir="rtl"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="department-edit-name">
                  {t("departments.name_en")}
                </Label>
                <Input
                  id="department-edit-name"
                  required
                  maxLength={120}
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  dir="ltr"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setIsEditOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={updateDept.isPending}
              >
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("departments.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("departments.delete_confirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
