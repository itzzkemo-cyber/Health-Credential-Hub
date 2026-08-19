import { useLanguage } from "@/lib/language-context";
import { useTheme } from "@/components/theme-provider";
import { Bell, Search, Moon, Sun, Globe, Menu } from "lucide-react";
import { useState } from "react";
import { AppSidebar } from "./Sidebar";
import { clearAuthSession, getAuthUser } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGetUnreadCount, useLogout } from "@workspace/api-client-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function AppHeader() {
  const { t, language, setLanguage, isRTL } = useLanguage();
  const { theme, setTheme } = useTheme();
  const [, setLocation] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const user = getAuthUser();
  const initials = (user?.nameAr || user?.name || "U")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part: string) => part[0])
    .join("")
    .toUpperCase();

  const { data: unreadData } = useGetUnreadCount();
  const unreadCount = unreadData?.count ?? 0;

  const logoutMutation = useLogout();

  const handleLogout = () => {
    // Ask the server to clear the httpOnly session cookie; drop the local
    // profile cache either way.
    logoutMutation.mutate(undefined, {
      onSettled: () => {
        clearAuthSession();
        setLocation("/login");
      },
    });
  };

  return (
    <header className="flex h-16 shrink-0 items-center gap-1 border-b border-border bg-card px-3 shadow-sm sm:gap-4 sm:px-6">
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t('common.menu')}>
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent
          side={isRTL ? "right" : "left"}
          className="w-64 p-0"
        >
          <SheetTitle className="sr-only">{t('common.menu')}</SheetTitle>
          <AppSidebar onNavigate={() => setMobileMenuOpen(false)} />
        </SheetContent>
      </Sheet>
      <span className="text-base font-bold text-primary sm:hidden">HealthDocs</span>
      <div className="hidden flex-1 items-center gap-4 sm:flex">
        <div className="relative w-full max-w-md">
          <Search className={cn("absolute top-2.5 h-4 w-4 text-muted-foreground", isRTL ? "right-3" : "left-3")} />
          <Input 
            placeholder={t('common.search')} 
            className={cn("bg-muted/50 h-9", isRTL ? "pr-9" : "pl-9")}
          />
        </div>
      </div>

      <div className="ms-auto flex items-center gap-0.5 sm:gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}
          className="rounded-full"
          title={t("mobile.change_language")}
          aria-label={t("mobile.change_language")}
        >
          <Globe className="h-5 w-5" />
          <span className="sr-only">{t("mobile.change_language")}</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          className="hidden rounded-full sm:inline-flex"
          aria-label={t("mobile.change_theme")}
        >
          {theme === "light" ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
          <span className="sr-only">{t("mobile.change_theme")}</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="relative hidden rounded-full sm:inline-flex"
          onClick={() => setLocation('/notifications')}
          aria-label={t("common.notifications")}
        >
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute top-1.5 right-1.5 flex h-2.5 w-2.5 rounded-full bg-destructive"></span>
          )}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-full bg-primary/10 hover:bg-primary/20">
              <span className="text-primary text-xs font-semibold">{initials}</span>
              <span className="sr-only">{t("mobile.open_account_menu")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => setLocation('/settings')}>
              {t('common.settings')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleLogout} className="text-destructive">
              {t('common.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function cn(...classes: (string | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
