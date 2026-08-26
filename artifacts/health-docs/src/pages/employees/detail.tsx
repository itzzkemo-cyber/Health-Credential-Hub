import { Link, useRoute, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEmployee,
  getGetEmployeeQueryKey,
  useTotpAdminDisable,
} from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { getAuthUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
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
import { ArrowRight, ArrowLeft, Mail, Phone, Briefcase, Building2, AlertTriangle, FileText, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const ADMIN_ROLES = ["hospital_admin", "system_admin"];

export default function EmployeeDetail() {
  const { t, isRTL } = useLanguage();
  const [, params] = useRoute("/employees/:id");
  const [, setLocation] = useLocation();
  const id = Number(params?.id);
  const queryClient = useQueryClient();
  const me = getAuthUser() as { role?: string } | null;
  const isAdmin = !!me?.role && ADMIN_ROLES.includes(me.role);
  const adminDisableMutation = useTotpAdminDisable();

  const { data: emp, isLoading, isError } = useGetEmployee(id);

  const handleAdminDisable = () => {
    adminDisableMutation.mutate(
      { data: { userId: id } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetEmployeeQueryKey(id) });
          toast.success(t("twofa.admin_disabled_success"));
        },
        onError: () => toast.error(t("twofa.invalid_code")),
      },
    );
  };

  if (isLoading) {
    return <div className="space-y-6"><Skeleton className="h-64 w-full" /></div>;
  }

  if (isError || !emp) {
    return <div className="text-center p-8 text-destructive">{t('employees_page.load_error')}</div>;
  }

  const getComplianceColor = (rate: number) => {
    if (rate >= 90) return 'bg-emerald-500';
    if (rate >= 70) return 'bg-amber-500';
    return 'bg-destructive';
  };

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'active': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400';
      case 'expiring_soon': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
      case 'expired': return 'bg-destructive/10 text-destructive dark:bg-destructive/20';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation('/employees')}
          aria-label={t('common.back')}
          className="h-11 w-11 shrink-0"
        >
          {isRTL ? <ArrowRight className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{t('employees_page.profile')}</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Left Column: Profile Card */}
        <div className="space-y-6">
          <Card className="hover-elevate overflow-hidden border-t-4 border-t-primary">
            <CardContent className="p-6">
              <div className="flex flex-col items-center text-center pb-6 border-b border-border">
                <div className="h-24 w-24 rounded-full bg-primary/10 text-primary flex items-center justify-center text-3xl font-bold mb-4">
                  {isRTL ? emp.nameAr[0] : emp.name[0]}
                </div>
                <h2 className="text-xl font-bold">{isRTL ? emp.nameAr : emp.name}</h2>
                <p className="text-muted-foreground text-sm">{t(`roles.${emp.role}`)}</p>
                {emp.isAtRisk && (
                  <Badge variant="destructive" className="mt-3 gap-1">
                    <AlertTriangle className="h-3 w-3" /> {t('employees_page.at_risk')}
                  </Badge>
                )}
              </div>

              <div className="py-6 border-b border-border space-y-4">
                <div className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
                  <Mail className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 break-all" dir="ltr">{emp.email}</span>
                </div>
                {emp.phone && (
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Phone className="h-4 w-4" />
                    <span>{emp.phone}</span>
                  </div>
                )}
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <Briefcase className="h-4 w-4" />
                  <span>{emp.employeeNumber || t('employees_page.not_available')}</span>
                </div>
                {emp.department && (
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Building2 className="h-4 w-4" />
                    <span>{isRTL ? emp.department.nameAr : emp.department.name}</span>
                  </div>
                )}
                {emp.totpEnabled && (
                  <div className="flex items-center gap-3 text-sm">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    <span className="text-emerald-700 dark:text-emerald-400">
                      {t("twofa.admin_badge")}
                    </span>
                  </div>
                )}
              </div>

              {emp.totpEnabled && isAdmin && (
                <div className="pt-6 border-b border-border pb-6">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full text-destructive border-destructive/40 hover:bg-destructive/10"
                        disabled={adminDisableMutation.isPending}
                      >
                        {t("twofa.admin_disable")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("twofa.admin_disable")}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("twofa.admin_disable_hint")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
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
                <p className="text-sm font-medium mb-3">{t('employees_page.overall_compliance')}</p>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-2xl font-bold">{emp.complianceRate || 0}%</span>
                </div>
                <Progress 
                  value={emp.complianceRate || 0} 
                  className="h-3" 
                  indicatorClassName={getComplianceColor(emp.complianceRate || 0)}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Credentials List */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="hover-elevate">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('employees_page.credentials')}</CardTitle>
              <Button size="sm" onClick={() => setLocation(`/credentials/new?employeeId=${emp.id}`)} className="gap-2">
                <Plus className="h-4 w-4" /> {t('common.add')}
              </Button>
            </CardHeader>
            <CardContent>
              {emp.missingCredentials && emp.missingCredentials.length > 0 && (
                <div className="mb-6 bg-destructive/5 border border-destructive/20 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-semibold text-destructive text-sm">{t('employees_page.missing_required')}</h4>
                      <ul className="list-disc list-inside mt-2 text-sm text-destructive/80 space-y-1">
                        {emp.missingCredentials.map((mc, idx) => (
                          <li key={idx}>{mc}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {emp.credentials?.length ? emp.credentials.map((cred) => (
                  <div key={cred.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/30 sm:flex-nowrap">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="shrink-0 rounded-md bg-primary/10 p-2">
                        <FileText className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <Link
                          href={`/credentials/${cred.id}`}
                          className="inline-flex min-h-11 max-w-full items-center rounded-sm font-medium transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <span className="truncate">{isRTL ? (cred.customTypeNameAr || cred.type) : (cred.customTypeName || cred.type)}</span>
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {t('employees_page.expires')}: {new Date(cred.expiryDate).toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}
                        </div>
                      </div>
                    </div>
                    <Badge className={`${getStatusColor(cred.status)} shrink-0`} variant="outline">
                      {t(`common.${cred.status}`)}
                    </Badge>
                  </div>
                )) : (
                  <div className="text-center py-8 text-muted-foreground border border-dashed rounded-lg">
                    {t('employees_page.no_active_credentials')}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

      </div>
    </div>
  );
}

function Plus(props: any) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M5 12h14"/><path d="M12 5v14"/></svg>;
}
