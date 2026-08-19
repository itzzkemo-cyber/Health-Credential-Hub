import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  RefreshCw,
  ShieldAlert,
  UploadCloud,
} from "lucide-react";
import {
  getGetDashboardStatsQueryKey,
  useGetDashboardStats,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import { ManagerDashboard } from "@/components/dashboard/ManagerDashboard";

const MANAGER_ROLES = [
  "supervisor",
  "department_manager",
  "hospital_admin",
  "system_admin",
] as const;

export default function Dashboard() {
  const { t, isRTL } = useLanguage();
  const user = getAuthUser();
  const isEmployee = (user?.role || "employee") === "employee";
  const isManager = MANAGER_ROLES.includes(user?.role);
  const {
    data: stats,
    isLoading,
    isError,
    refetch,
  } = useGetDashboardStats({
    query: {
      queryKey: getGetDashboardStatsQueryKey(),
      enabled: !isManager,
    },
  });

  if (isManager) return <ManagerDashboard />;

  if (isLoading) {
    return (
      <div className="space-y-5" aria-busy="true">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[1, 2, 3, 4].map((item) => (
            <Skeleton key={item} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !stats) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
          <ShieldAlert
            className="h-10 w-10 text-destructive"
            aria-hidden="true"
          />
          <p className="font-medium">{t("employee_portal.dashboard_error")}</p>
          <Button
            variant="outline"
            onClick={() => void refetch()}
            className="min-h-11 gap-2"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t("employee_portal.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const statCards = [
    {
      label: t("stats.total_credentials"),
      value: stats.totalCredentials || 0,
      icon: FileText,
      accent: "text-primary",
    },
    {
      label: t("stats.active_credentials"),
      value: stats.activeCredentials || 0,
      icon: CheckCircle2,
      accent: "text-emerald-600",
    },
    {
      label: t("stats.expiring_credentials"),
      value: stats.expiringCredentials || 0,
      icon: AlertTriangle,
      accent: "text-amber-600",
    },
    {
      label: t("stats.expired_credentials"),
      value: stats.expiredCredentials || 0,
      icon: ShieldAlert,
      accent: "text-destructive",
    },
  ];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 md:space-y-8">
      {isEmployee ? (
        <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card">
          <CardContent className="grid gap-6 p-5 sm:p-7 md:grid-cols-[1fr_auto] md:items-center">
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-primary">
                  {t("employee_portal.dashboard_eyebrow")}
                </p>
                <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
                  {t("auth.welcome_back")}, {isRTL ? user?.nameAr : user?.name}
                </h1>
              </div>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                {t("employee_portal.dashboard_subtitle")}
              </p>
              <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                  aria-hidden="true"
                />
                {t("employee_portal.private_upload")}
              </p>
            </div>
            <Button
              asChild
              size="lg"
              className="min-h-12 w-full gap-2 shadow-sm md:w-auto"
            >
              <Link href="/credentials/new">
                <UploadCloud className="h-5 w-5" aria-hidden="true" />
                {t("employee_portal.upload_action")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">
            {t("common.dashboard")}
          </h1>
          <p className="text-muted-foreground">
            {t("auth.welcome_back")}, {isRTL ? user?.nameAr : user?.name}
          </p>
        </div>
      )}

      <section
        aria-label={t("employee_portal.document_summary")}
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        {statCards.map(({ label, value, icon: Icon, accent }) => (
          <Card key={label} className="hover-elevate">
            <CardContent className="p-4 sm:p-5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-medium leading-5 text-muted-foreground sm:text-sm">
                  {label}
                </p>
                <Icon
                  className={`h-5 w-5 shrink-0 ${accent}`}
                  aria-hidden="true"
                />
              </div>
              <p className="mt-3 text-3xl font-bold tabular-nums">{value}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-7">
        <Card className="hover-elevate lg:col-span-4">
          <CardHeader className="pb-3">
            <CardTitle>{t("employee_portal.upcoming_expirations")}</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.upcomingExpirations &&
            stats.upcomingExpirations.length > 0 ? (
              <div className="divide-y divide-border">
                {stats.upcomingExpirations.slice(0, 5).map((credential) => (
                  <div
                    key={credential.id}
                    className="flex items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {isRTL
                          ? credential.customTypeNameAr || credential.type
                          : credential.customTypeName || credential.type}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(credential.expiryDate).toLocaleDateString(
                          isRTL ? "ar-SA" : "en-US",
                        )}
                      </p>
                    </div>
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="min-h-11 shrink-0"
                    >
                      <Link href={`/credentials/${credential.id}`}>
                        {t("common.view")}
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center">
                <CheckCircle2
                  className="mx-auto h-9 w-9 text-emerald-600"
                  aria-hidden="true"
                />
                <p className="mt-3 text-sm text-muted-foreground">
                  {t("employee_portal.no_upcoming_expirations")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-primary/20 bg-primary/5 lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle>
              {isEmployee
                ? t("employee_portal.my_compliance")
                : t("stats.compliance_rate")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <span className="text-4xl font-bold text-primary tabular-nums">
                {Math.round(stats.complianceRate || 0)}%
              </span>
              <span className="text-xs text-muted-foreground">
                {stats.missingCredentials || 0} {t("stats.missing_credentials")}
              </span>
            </div>
            <div
              className="h-3 overflow-hidden rounded-full bg-primary/15"
              role="progressbar"
              aria-label={t("stats.compliance_rate")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(stats.complianceRate || 0)}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-700"
                style={{
                  width: `${Math.max(0, Math.min(100, stats.complianceRate || 0))}%`,
                }}
              />
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              {isEmployee
                ? t("employee_portal.compliance_hint")
                : t("employee_portal.facility_compliance_hint")}
            </p>
            {isEmployee && (
              <Button asChild variant="outline" className="min-h-11 w-full">
                <Link href="/credentials">
                  {t("employee_portal.review_documents")}
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
