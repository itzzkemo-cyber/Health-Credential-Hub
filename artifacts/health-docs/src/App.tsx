import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@workspace/api-client-react';
import { clearAuthSession, isAuthenticated } from '@/lib/auth';
import { lazy, Suspense } from 'react';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import { ThemeProvider } from '@/components/theme-provider';
import { LanguageProvider } from '@/lib/i18n';
import { useLanguage } from '@/lib/language-context';
import { AppShell } from '@/components/layout/Shell';

// Split route bundles so mobile employees do not download management screens up front.
const Login = lazy(() => import('@/pages/login'));
const Register = lazy(() => import('@/pages/register'));
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
const IntegrationsView = lazy(() => import('@/pages/integrations'));
const VerifyQR = lazy(() => import('@/pages/verify'));
const Settings = lazy(() => import('@/pages/settings'));
const NotFound = lazy(() => import('@/pages/not-found'));

function RouteFallback() {
  const { t } = useLanguage();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
      <span className="ms-3">{t('common.loading')}</span>
    </div>
  );
}

// The session lives in an httpOnly cookie, so the client can't inspect it.
// When it expires or is revoked the API answers 401 — drop the cached profile
// and return to the login page.
function handleUnauthorized(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && isAuthenticated()) {
    clearAuthSession();
    window.location.assign(`${import.meta.env.BASE_URL}login`);
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleUnauthorized }),
  mutationCache: new MutationCache({ onError: handleUnauthorized }),
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
      <Route path="/register" component={Register} />
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
            <Route path="/employees" component={EmployeesList} />
            <Route path="/employees/:id" component={EmployeeDetail} />
            <Route path="/departments" component={DepartmentsList} />
            <Route path="/notifications" component={NotificationsList} />
            <Route path="/audit-log" component={AuditLogList} />
            <Route path="/reports" component={ReportsView} />
            <Route path="/policies" component={PoliciesList} />
            <Route path="/integrations" component={IntegrationsView} />
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
              <Suspense fallback={<RouteFallback />}>
                <Router />
              </Suspense>
            </WouterRouter>
            <Toaster position="top-center" richColors />
          </TooltipProvider>
        </LanguageProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
