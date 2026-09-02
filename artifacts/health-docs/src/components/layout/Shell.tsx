import { ReactNode } from "react";
import { AppSidebar } from "./Sidebar";
import { AppHeader } from "./Header";
import { MobileBottomNav } from "./MobileBottomNav";
import { getAuthUser, isAuthenticated } from "@/lib/auth";
import { Redirect, useLocation } from "wouter";
import {
  authenticatedLandingPath,
  mustReplaceTemporaryPassword,
  type AccountSetupUser,
} from "@/lib/password-change-state";
import { mustEnrollPrivilegedMfa } from "@/lib/account-security-state";
import { AppFooter } from "./AppFooter";

export function AppShell({ children }: { children: ReactNode }) {
  // The session itself is an httpOnly cookie the JS cannot read; this only
  // checks the cached profile. If the cookie is gone the API answers 401 and
  // the global handler in App.tsx clears the cache and redirects to login.
  const authed = isAuthenticated();
  const user = getAuthUser() as AccountSetupUser | null;
  const passwordChangeRequired = mustReplaceTemporaryPassword(user);
  const mfaEnrollmentRequired = mustEnrollPrivilegedMfa(user);
  const [location] = useLocation();

  // If not logged in and not on a public route, redirect to login
  if (!authed && location !== "/login" && !location.startsWith("/verify/")) {
    return <Redirect to="/login" />;
  }

  // If logged in and on login, redirect to dashboard
  if (authed && location === "/login") {
    return <Redirect to={authenticatedLandingPath(user)} />;
  }

  // Provisioned accounts are intentionally restricted to one task until the
  // server-confirmed temporary password has been replaced. The API enforces
  // the same boundary; this redirect keeps the web experience clear.
  if (passwordChangeRequired && location !== "/settings") {
    return <Redirect to="/settings" />;
  }

  // Privileged accounts remain limited to security settings until the API-
  // confirmed profile reports TOTP enabled. Server middleware enforces the
  // same boundary for every protected request.
  if (mfaEnrollmentRequired && location !== "/settings") {
    return <Redirect to="/settings" />;
  }

  if (
    (passwordChangeRequired || mfaEnrollmentRequired) &&
    location === "/settings"
  ) {
    return (
      <main className="flex min-h-[100dvh] w-full flex-col bg-slate-50 p-4 dark:bg-slate-950 sm:p-6">
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-2xl">{children}</div>
        </div>
        <AppFooter />
      </main>
    );
  }

  // Hide shell for login and verify
  if (location === "/login" || location.startsWith("/verify/")) {
    return (
      <div className="flex min-h-[100dvh] w-full flex-col bg-background">
        <div className="flex flex-1 flex-col">{children}</div>
        <AppFooter />
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      <div className="hidden lg:block shrink-0">
        <AppSidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <AppHeader />
        <main className="mobile-main-padding flex flex-1 flex-col overflow-y-auto bg-slate-50 p-4 dark:bg-slate-900 md:p-6 lg:pb-6">
          <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col">
            <div className="flex-1">{children}</div>
            <AppFooter className="mt-10" />
          </div>
        </main>
        <MobileBottomNav />
      </div>
    </div>
  );
}
