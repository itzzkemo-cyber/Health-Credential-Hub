import { useLanguage } from "@/lib/language-context";
import { useGetDashboardStats } from "@workspace/api-client-react";
import { getAuthUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, AlertTriangle, ShieldAlert, CheckCircle2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

export default function Dashboard() {
  const { t, isRTL } = useLanguage();
  const user = getAuthUser();
  const role = user?.role || 'employee';

  const { data: stats, isLoading, isError } = useGetDashboardStats();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">{t('common.dashboard')}</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      </div>
    );
  }

  if (isError || !stats) {
    return (
      <div className="p-8 text-center text-destructive">
        Error loading dashboard stats. Please try again.
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t('common.dashboard')}</h1>
        <p className="text-muted-foreground">
          {t('auth.welcome_back')}, {user?.nameAr || user?.name}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="hover-elevate">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('stats.total_credentials')}</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalCredentials || 0}</div>
          </CardContent>
        </Card>

        <Card className="hover-elevate border-l-4 border-l-emerald-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('stats.active_credentials')}</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.activeCredentials || 0}</div>
          </CardContent>
        </Card>

        <Card className="hover-elevate border-l-4 border-l-amber-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('stats.expiring_credentials')}</CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.expiringCredentials || 0}</div>
          </CardContent>
        </Card>

        <Card className="hover-elevate border-l-4 border-l-destructive">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('stats.expired_credentials')}</CardTitle>
            <ShieldAlert className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.expiredCredentials || 0}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="lg:col-span-4 hover-elevate">
          <CardHeader>
            <CardTitle>Upcoming Expirations</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.upcomingExpirations && stats.upcomingExpirations.length > 0 ? (
              <div className="space-y-4">
                {stats.upcomingExpirations.slice(0, 5).map(cred => (
                  <div key={cred.id} className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0">
                    <div>
                      <p className="font-medium text-sm">
                        {isRTL ? (cred.customTypeNameAr || cred.type) : (cred.customTypeName || cred.type)}
                      </p>
                      <p className="text-xs text-muted-foreground">{cred.holderName}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-amber-600">
                        {new Date(cred.expiryDate).toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}
                      </p>
                      <Link href={`/credentials/${cred.id}`} className="text-xs text-primary hover:underline">
                        {t('common.view')}
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground py-8 text-center">
                No upcoming expirations.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3 hover-elevate bg-primary/5 border-primary/20">
          <CardHeader>
            <CardTitle>{t('stats.compliance_rate')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-8">
            <div className="relative h-40 w-40 flex items-center justify-center rounded-full border-8 border-primary/20">
              <div 
                className="absolute inset-0 rounded-full border-8 border-primary"
                style={{ 
                  clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%)`, 
                  transform: `rotate(${(stats.complianceRate || 0) * 3.6}deg)`, 
                  transition: 'transform 1s ease-out' 
                }} 
              />
              <div className="text-4xl font-bold text-primary">
                {Math.round(stats.complianceRate || 0)}%
              </div>
            </div>
            <p className="mt-4 text-sm font-medium text-center">
              Facility-wide compliance is looking good.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
