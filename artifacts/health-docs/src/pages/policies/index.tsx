import { useState } from "react";
import { useListPolicies, useCreatePolicy, useDeletePolicy, getListPoliciesQueryKey, useListDepartments } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { getAuthUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ShieldCheck, Plus, Trash2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";

const CREDENTIAL_TYPES = [
  "Saudi_License",
  "BLS",
  "ACLS",
  "PALS",
  "NRP",
  "Degree",
  "Specialty_Certificate",
  "Iqama",
  "National_ID",
  "Passport",
  "Malpractice_Insurance",
  "Health_Fitness",
  "Vaccination_Record",
  "Data_Flow",
  "CME_Hours",
  "Fire_Safety",
  "Infection_Control",
  "Quality_Management",
  "Risk_Management",
  "Patient_Safety",
  "Other"
];

const ROLES = ['employee', 'supervisor', 'department_manager', 'hospital_admin', 'system_admin'];

export default function Policies() {
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();
  const { data: policies, isLoading } = useListPolicies();
  const { data: departments } = useListDepartments();
  const createPolicy = useCreatePolicy();
  const deletePolicy = useDeletePolicy();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selectedPolicy, setSelectedPolicy] = useState<any>(null);

  const [formData, setFormData] = useState({
    credentialType: "",
    departmentId: null as number | null,
    roles: [] as string[],
    isRequired: true
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.credentialType || formData.roles.length === 0) {
      toast.error("Please fill all required fields");
      return;
    }

    createPolicy.mutate({ data: formData }, {
      onSuccess: () => {
        toast.success(t('policies.create_success'));
        setIsCreateOpen(false);
        queryClient.invalidateQueries({ queryKey: getListPoliciesQueryKey() });
      }
    });
  };

  const handleDelete = () => {
    if (!selectedPolicy) return;
    deletePolicy.mutate({ id: selectedPolicy.id }, {
      onSuccess: () => {
        toast.success(t('policies.delete_success'));
        setIsDeleteOpen(false);
        queryClient.invalidateQueries({ queryKey: getListPoliciesQueryKey() });
      }
    });
  };

  const toggleRole = (role: string) => {
    setFormData(prev => ({
      ...prev,
      roles: prev.roles.includes(role) 
        ? prev.roles.filter(r => r !== role) 
        : [...prev.roles, role]
    }));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('policies.title')}</h1>
          <p className="text-muted-foreground">{t('policies.subtitle')}</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          {t('policies.add')}
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse h-48" />
          ))}
        </div>
      ) : !policies?.length ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <div className="h-16 w-16 bg-muted rounded-full flex items-center justify-center text-muted-foreground mb-4">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h3 className="text-lg font-semibold">{t('policies.empty')}</h3>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {policies.map((policy) => {
            const dept = departments?.find(d => d.id === policy.departmentId);
            return (
              <Card key={policy.id} className="relative overflow-hidden border-border/50">
                <div className={`absolute top-0 w-full h-1 ${policy.isRequired ? 'bg-primary' : 'bg-muted-foreground'}`} />
                <CardContent className="p-6 pt-8 space-y-4">
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <Badge variant="outline" className="mb-2 bg-muted/50 font-mono text-xs">{policy.credentialType.replace(/_/g, ' ')}</Badge>
                      <h3 className="font-bold text-lg leading-tight">
                        {policy.isRequired ? 'إلزامي لـ' : 'اختياري لـ'}
                        {' '}
                        {dept ? (language === 'ar' ? dept.nameAr : dept.name) : t('common.all')}
                      </h3>
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0" onClick={() => { setSelectedPolicy(policy); setIsDeleteOpen(true); }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  
                  <div>
                    <span className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">{t('policies.roles')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {policy.roles.map(role => (
                        <Badge key={role} variant="secondary" className="font-normal text-xs">{t(`roles.${role}`)}</Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>{t('policies.add')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-6 py-4">
              <div className="space-y-2">
                <Label>{t('policies.type')}</Label>
                <Select value={formData.credentialType} onValueChange={(v) => setFormData({ ...formData, credentialType: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {CREDENTIAL_TYPES.map(t => (
                      <SelectItem key={t} value={t}>{t.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>{t('policies.department')}</Label>
                <Select 
                  value={formData.departmentId ? formData.departmentId.toString() : "all"} 
                  onValueChange={(v) => setFormData({ ...formData, departmentId: v === "all" ? null : parseInt(v) })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All Departments" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('common.all')}</SelectItem>
                    {departments?.map(d => (
                      <SelectItem key={d.id} value={d.id.toString()}>
                        {language === 'ar' ? d.nameAr : d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                <Label>{t('policies.roles')}</Label>
                <div className="grid grid-cols-2 gap-3 p-4 rounded-xl border bg-muted/10">
                  {ROLES.map(role => (
                    <div key={role} className="flex items-center space-x-2 space-x-reverse">
                      <Checkbox 
                        id={`role-${role}`} 
                        checked={formData.roles.includes(role)}
                        onCheckedChange={() => toggleRole(role)}
                      />
                      <label htmlFor={`role-${role}`} className="text-sm cursor-pointer">{t(`roles.${role}`)}</label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center space-x-2 space-x-reverse pt-2">
                <Checkbox 
                  id="required" 
                  checked={formData.isRequired}
                  onCheckedChange={(c) => setFormData({ ...formData, isRequired: !!c })}
                />
                <label htmlFor="required" className="text-sm font-medium">{t('policies.is_required')}</label>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={createPolicy.isPending}>{t('common.save')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common.delete')}</AlertDialogTitle>
            <AlertDialogDescription className="text-destructive font-medium flex gap-2 items-start mt-2">
              <ShieldAlert className="h-5 w-5 shrink-0" />
              {t('policies.delete_confirm')}
            </AlertDialogDescription>
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
