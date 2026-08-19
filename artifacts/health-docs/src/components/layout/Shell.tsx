import { ReactNode } from "react";
import { AppSidebar } from "./Sidebar";
import { AppHeader } from "./Header";
import { MobileBottomNav } from "./MobileBottomNav";
import { isAuthenticated } from "@/lib/auth";
import { Redirect, useLocation } from "wouter";

export function AppShell({ children }: { children: ReactNode }) {
  // The session itself is an httpOnly cookie the JS cannot read; this only
  // checks the cached profile. If the cookie is gone the API answers 401 and
  // the global handler in App.tsx clears the cache and redirects to login.
  const authed = isAuthenticated();
  const [location] = useLocation();

  // If not logged in and not on a public route, redirect to login
  if (!authed && location !== "/login" && !location.startsWith("/verify/")) {
    return <Redirect to="/login" />;
  }

  // If logged in and on login, redirect to dashboard
  if (authed && location === "/login") {
    return <Redirect to="/" />;
  }

  // Hide shell for login and verify
  if (location === "/login" || location.startsWith("/verify/")) {
    return <div className="min-h-[100dvh] bg-background w-full">{children}</div>;
  }

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      <div className="hidden lg:block shrink-0">
        <AppSidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <AppHeader />
        <main className="mobile-main-padding flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-slate-900 md:p-6 lg:pb-6">
          <div className="mx-auto max-w-6xl w-full">
            {children}
          </div>
        </main>
        <MobileBottomNav />
      </div>
    </div>
  );
}
