import { Bell, FileText, Home, Settings, UploadCloud } from "lucide-react";
import { Link, useLocation } from "wouter";

import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

/**
 * Employee-first mobile navigation. Management roles keep the drawer because
 * their wider information architecture does not fit safely into five tabs.
 */
export function MobileBottomNav() {
  const [location] = useLocation();
  const { t } = useLanguage();
  const user = getAuthUser();

  if (user?.role !== "employee") return null;

  const items = [
    { icon: Home, label: t("mobile.home"), path: "/" },
    { icon: FileText, label: t("mobile.documents"), path: "/credentials" },
    { icon: Bell, label: t("mobile.alerts"), path: "/notifications" },
    { icon: Settings, label: t("mobile.account"), path: "/settings" },
  ];

  return (
    <nav
      aria-label={t("mobile.navigation")}
      className="mobile-safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 px-2 pt-2 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] backdrop-blur lg:hidden"
    >
      <div className="mx-auto grid max-w-lg grid-cols-5 items-end">
        {items.slice(0, 2).map((item) => (
          <MobileNavLink key={item.path} {...item} active={isActive(location, item.path)} />
        ))}

        <Link
          href="/credentials/new"
          aria-label={t("mobile.upload")}
          className="group -mt-7 flex min-h-16 flex-col items-center justify-end gap-1 text-xs font-semibold text-primary"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full border-4 border-card bg-primary text-primary-foreground shadow-lg transition-transform group-active:scale-95">
            <UploadCloud className="h-6 w-6" aria-hidden="true" />
          </span>
          <span>{t("mobile.upload")}</span>
        </Link>

        {items.slice(2).map((item) => (
          <MobileNavLink key={item.path} {...item} active={isActive(location, item.path)} />
        ))}
      </div>
    </nav>
  );
}

function MobileNavLink({
  icon: Icon,
  label,
  path,
  active,
}: {
  icon: typeof Home;
  label: string;
  path: string;
  active: boolean;
}) {
  return (
    <Link
      href={path}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-medium transition-colors",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
      <span className="max-w-full truncate">{label}</span>
    </Link>
  );
}

function isActive(location: string, path: string): boolean {
  return path === "/" ? location === "/" : location.startsWith(path);
}
