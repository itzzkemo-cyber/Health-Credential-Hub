import { useState } from "react";
import { useListDepartments, useCreateDepartment, useUpdateDepartment, useDeleteDepartment, getListDepartmentsQueryKey } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { getAuthUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Building2, Plus, Users, Activity, AlertTriangle, CheckCircle, Edit, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

export default function Departments() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const user = getAuthUser();
  const isAdmin = user?.role === 'hospital_admin' || user?.role === 'system_admin';

  const { data: departments, isLoading } = useListDepartments();
  
  const createDept = useCreateDepartment();
  const updateDept = useUpdateDepartment();
  const deleteDept = useDeleteDepartment();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selectedDept, setSelectedDept] = useState<any>(null);

  const [formData, setFormData] = useState({ name: "", nameAr: "" });

  const handleOpenCreate = () => {
    setFormData({ name: "", nameAr: "" });
    setIsCreateOpen(true);
  };

  const handleOpenEdit = (dept: any) => {
    setSelectedDept(dept);
    setFormData({ name: dept.name, nameAr: dept.nameAr || "" });
    setIsEditOpen(true);
  };

  const handleOpenDelete = (dept: any) => {
    setSelectedDept(dept);
    setIsDeleteOpen(true);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createDept.mutate({ data: formData }, {
      onSuccess: () => {
        toast.success(t('departments.create_success'));
        setIsCreateOpen(false);
        queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() });
      }
    });
  };

  const handleEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDept) return;
    updateDept.mutate({ id: selectedDept.id, data: formData }, {
      onSuccess: () => {
        toast.success(t('departments.update_success'));
        setIsEditOpen(false);
        queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() });
      }
    });
  };

  const handleDelete = () => {
    if (!selectedDept) return;
    deleteDept.mutate({ id: selectedDept.id }, {
      onSuccess: () => {
        toast.success(t('departments.delete_success'));
        setIsDeleteOpen(false);
        queryClient.invalidateQueries({ queryKey: getListDepartmentsQueryKey() });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('departments.title')}</h1>
          <p className="text-muted-foreground">{t('departments.subtitle')}</p>
        </div>
        {isAdmin && (
          <Button onClick={handleOpenCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            {t('departments.add')}
          </Button>
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
          <h3 className="text-lg font-semibold">{t('departments.no_departments')}</h3>
          {isAdmin && (
            <Button onClick={handleOpenCreate} variant="outline" className="mt-4 gap-2">
              <Plus className="h-4 w-4" />
              {t('departments.add')}
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {departments?.map((dept) => (
            <Card key={dept.id} className="overflow-hidden hover-elevate transition-all border-border/50">
              <div className="p-6 pb-4 border-b bg-muted/20 flex justify-between items-start">
                <div className="space-y-1">
                  <h3 className="font-bold text-xl">{document.documentElement.lang === 'en' && dept.name ? dept.name : dept.nameAr}</h3>
                </div>
                {isAdmin && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => handleOpenEdit(dept)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleOpenDelete(dept)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
              <CardContent className="p-6 pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Users className="h-4 w-4" />
                    <span className="text-sm">{t('departments.employee_count')}</span>
                  </div>
                  <span className="font-semibold text-lg">{dept.employeeCount}</span>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Activity className="h-4 w-4" />
                      <span>{t('departments.compliance')}</span>
                    </div>
                    <span className="font-semibold">{dept.complianceRate}%</span>
                  </div>
                  <Progress value={dept.complianceRate} className="h-2" />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t">
                  <div className="flex flex-col gap-1 p-2 rounded-lg bg-red-500/10 text-red-700 dark:text-red-400">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <AlertTriangle className="h-3 w-3" />
                      {t('common.expired')}
                    </div>
                    <span className="text-lg font-bold">{dept.expiredCount}</span>
                  </div>
                  <div className="flex flex-col gap-1 p-2 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <Activity className="h-3 w-3" />
                      {t('common.expiring_soon')}
                    </div>
                    <span className="text-lg font-bold">{dept.expiringCount}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>{t('departments.add')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>{t('departments.name')}</Label>
                <Input required value={formData.nameAr} onChange={(e) => setFormData({ ...formData, nameAr: e.target.value })} dir="rtl" />
              </div>
              <div className="space-y-2">
                <Label>{t('departments.name_en')}</Label>
                <Input required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} dir="ltr" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={createDept.isPending}>{t('common.save')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent>
          <form onSubmit={handleEdit}>
            <DialogHeader>
              <DialogTitle>{t('departments.edit')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>{t('departments.name')}</Label>
                <Input required value={formData.nameAr} onChange={(e) => setFormData({ ...formData, nameAr: e.target.value })} dir="rtl" />
              </div>
              <div className="space-y-2">
                <Label>{t('departments.name_en')}</Label>
                <Input required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} dir="ltr" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsEditOpen(false)}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={updateDept.isPending}>{t('common.save')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('departments.delete')}</AlertDialogTitle>
            <AlertDialogDescription>{t('departments.delete_confirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
