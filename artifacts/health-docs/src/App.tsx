import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@workspace/api-client-react';
import { clearAuthSession, isAuthenticated } from '@/lib/auth';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import { ThemeProvider } from '@/components/theme-provider';
import { LanguageProvider } from '@/lib/i18n';
import { AppShell } from '@/components/layout/Shell';

// Pages
import Login from '@/pages/login';
import Register from '@/pages/register';
import ForgotPassword from '@/pages/forgot-password';
import ResetPassword from '@/pages/reset-password';
import TwoFactorChallenge from '@/pages/two-factor-challenge';
import Dashboard from '@/pages/dashboard';
import CredentialsList from '@/pages/credentials';
import CredentialNew from '@/pages/credentials/new';
import CredentialDetail from '@/pages/credentials/detail';
import EmployeesList from '@/pages/employees';
import EmployeeDetail from '@/pages/employees/detail';
import DepartmentsList from '@/pages/departments';
import NotificationsList from '@/pages/notifications';
import AuditLogList from '@/pages/audit-log';
import ReportsView from '@/pages/reports';
import PoliciesList from '@/pages/policies';
import IntegrationsView from '@/pages/integrations';

import VerifyQR from '@/pages/verify';
import Settings from '@/pages/settings';

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
              <Router />
            </WouterRouter>
            <Toaster position="top-center" richColors />
          </TooltipProvider>
        </LanguageProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
