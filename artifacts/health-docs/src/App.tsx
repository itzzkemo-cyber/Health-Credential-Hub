import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, useGetMe } from '@workspace/api-client-react';
import { clearAuthSession, getAuthUser, isAuthenticated, setAuthSession } from '@/lib/auth';
import { lazy, Suspense, type ReactNode, useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Link, Route, Switch, Router as WouterRouter } from 'wouter';
import { ShieldX } from 'lucide-react';

import { ThemeProvider } from '@/components/theme-provider';
import { LanguageProvider } from '@/lib/i18n';
import { useLanguage } from '@/lib/language-context';
import { AppShell } from '@/components/layout/Shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { withPasswordChangeState } from '@/lib/password-change-state';
import {
  isMfaEnrollmentRequiredApiError,
  withMfaEnrollmentState,
} from '@/lib/account-security-state';

// Split route bundles so mobile employees do not download management screens up front.
const Login = lazy(() => import('@/pages/login'));
const ForgotPassword = lazy(() => import('@/pages/forgot-password'));
const ResetPassword = lazy(() => import('@/pages/reset-password'));
const TwoFactorChallenge = lazy(() => import('@/pages/two-factor-challenge'));
const Dashboard = lazy(() => import('@/pages/dashboard'));
const CredentialsList = lazy(() => import('@/pages/credentials'));
const CredentialNew = lazy(() => import('@/pages/credentials/new'));
const CredentialDetail = lazy(() => import('@/pages/credentials/detail'));
const EmployeesList = lazy(() => import('@/pages/employees'));
const EmployeeDetail = lazy(() => import('@/pages/employees/detail'));
const DepartmentsList = lazy(() => import('@/pages/departments'));
const NotificationsList = lazy(() => import('@/pages/notifications'));
const AuditLogList = lazy(() => import('@/pages/audit-log'));
const ReportsView = lazy(() => import('@/pages/reports'));
const PoliciesList = lazy(() => import('@/pages/policies'));
const VerifyQR = lazy(() => import('@/pages/verify'));
const Settings = lazy(() => import('@/pages/settings'));
const NotFound = lazy(() => import('@/pages/not-found'));

type AppRole =
  | 'employee'
  | 'supervisor'
  | 'department_manager'
  | 'hospital_admin'
  | 'system_admin';

const MANAGEMENT_ROLES: readonly AppRole[] = [
  'supervisor',
  'department_manager',
  'hospital_admin',
  'system_admin',
];
const ADMIN_ROLES: readonly AppRole[] = ['hospital_admin', 'system_admin'];

// This is a navigation/UX boundary only. Every management request is still
// authorized and scoped by the API, which remains the source of truth.
function AllowedRoles({
  roles,
  children,
}: {
  roles: readonly AppRole[];
  children: ReactNode;
}) {
  const role = (getAuthUser() as { role?: AppRole } | null)?.role;

  if (!role || !roles.includes(role)) {
    return <ForbiddenRoute />;
  }

  return children;
}

function ForbiddenRoute() {
  const { t } = useLanguage();

  return (
    <Card className="mx-auto max-w-lg border-destructive/30">
      <CardContent
        className="flex flex-col items-center gap-4 p-8 text-center"
        role="alert"
        aria-live="assertive"
      >
        <ShieldX className="h-12 w-12 text-destructive" aria-hidden="true" />
        <div className="space-y-2">
          <h1 className="text-xl font-bold">{t('common.forbidden_title')}</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {t('common.forbidden_description')}
          </p>
        </div>
        <Button asChild className="min-h-11">
          <Link href="/">{t('common.go_home')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function RouteFallback() {
  const { t } = useLanguage();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
      <span className="ms-3">{t('common.loading')}</span>
    </div>
  );
}

function AuthSessionGate({ children }: { children: ReactNode }) {
  const { data: user, isError, isSuccess } = useGetMe();
  const [isResolved, setIsResolved] = useState(false);

  useEffect(() => {
    if (isSuccess) {
      setAuthSession(user);
      setIsResolved(true);
      return;
    }

    if (isError) {
      // A missing, expired, revoked, or unverifiable cookie never inherits a
      // browser-cached identity. Protected routes remain fail-closed.
      clearAuthSession();
      setIsResolved(true);
    }
  }, [isError, isSuccess, user]);

  if (!isResolved) return <RouteFallback />;

  return children;
}

// The session lives in an httpOnly cookie, so the client can't inspect it.
// When it expires or is revoked the API answers 401 — drop the cached profile
// and return to the login page.
function handleAuthError(error: unknown) {
  if (!(error instanceof ApiError)) return;

  if (error.status === 401 && isAuthenticated()) {
    clearAuthSession();
    window.location.assign(`${import.meta.env.BASE_URL}login`);
    return;
  }

  if (isMfaEnrollmentRequiredApiError(error)) {
    const user = getAuthUser() as Record<string, unknown> | null;
    if (user) setAuthSession(withMfaEnrollmentState(user, true));
    window.location.assign(`${import.meta.env.BASE_URL}settings`);
    return;
  }

  const code = (error.data as { code?: string } | null)?.code;
  if (error.status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') {
    const user = getAuthUser() as Record<string, unknown> | null;
    if (user) setAuthSession(withPasswordChangeState(user, true));
    window.location.assign(`${import.meta.env.BASE_URL}settings`);
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/2fa-challenge" component={TwoFactorChallenge} />
      <Route path="/verify/:token" component={VerifyQR} />

      <Route>
        <AppShell>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/credentials" component={CredentialsList} />
            <Route path="/credentials/new" component={CredentialNew} />
            <Route path="/credentials/:id" component={CredentialDetail} />
            <Route path="/employees">
              <AllowedRoles roles={MANAGEMENT_ROLES}>
                <EmployeesList />
              </AllowedRoles>
            </Route>
            <Route path="/employees/:id">
              <AllowedRoles roles={MANAGEMENT_ROLES}>
                <EmployeeDetail />
              </AllowedRoles>
            </Route>
            <Route path="/departments">
              <AllowedRoles roles={ADMIN_ROLES}>
                <DepartmentsList />
              </AllowedRoles>
            </Route>
            <Route path="/notifications" component={NotificationsList} />
            <Route path="/audit-log">
              <AllowedRoles roles={ADMIN_ROLES}>
                <AuditLogList />
              </AllowedRoles>
            </Route>
            <Route path="/reports">
              <AllowedRoles roles={MANAGEMENT_ROLES}>
                <ReportsView />
              </AllowedRoles>
            </Route>
            <Route path="/policies">
              <AllowedRoles roles={ADMIN_ROLES}>
                <PoliciesList />
              </AllowedRoles>
            </Route>
            <Route path="/settings" component={Settings} />

            <Route component={NotFound} />
          </Switch>
        </AppShell>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light" storageKey="healthdocs-theme">
        <LanguageProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <AuthSessionGate>
                <Suspense fallback={<RouteFallback />}>
                  <Router />
                </Suspense>
              </AuthSessionGate>
            </WouterRouter>
            <Toaster position="top-center" richColors />
          </TooltipProvider>
        </LanguageProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
