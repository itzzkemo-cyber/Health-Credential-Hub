import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  FileText,
  Users,
  Building2,
  Bell,
  ShieldCheck,
  FileBarChart,
  Settings,
} from "lucide-react";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";
import { getAuthUser } from "@/lib/auth";

export function AppSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [location] = useLocation();
  const { t, language } = useLanguage();
  const user = getAuthUser();
  const role = user?.role || "employee";
  const localizedName =
    language === "ar" ? user?.nameAr || user?.name : user?.name || user?.nameAr;

  const menuItems = [
    {
      icon: LayoutDashboard,
      label: t("common.dashboard"),
      path: "/",
      roles: [
        "employee",
        "supervisor",
        "department_manager",
        "hospital_admin",
        "system_admin",
      ],
    },
    {
      icon: FileText,
      label: t("common.credentials"),
      path: "/credentials",
      roles: [
        "employee",
        "supervisor",
        "department_manager",
        "hospital_admin",
        "system_admin",
      ],
    },
    {
      icon: Bell,
      label: t("common.notifications"),
      path: "/notifications",
      roles: [
        "employee",
        "supervisor",
        "department_manager",
        "hospital_admin",
        "system_admin",
      ],
    },
    {
      icon: Users,
      label: t("common.employees"),
      path: "/employees",
      roles: [
        "supervisor",
        "department_manager",
        "hospital_admin",
        "system_admin",
      ],
    },
    {
      icon: Building2,
      label: t("common.departments"),
      path: "/departments",
      roles: ["hospital_admin", "system_admin"],
    },
    {
      icon: ShieldCheck,
      label: t("common.policies"),
      path: "/policies",
      roles: ["hospital_admin", "system_admin"],
    },
    {
      icon: FileBarChart,
      label: t("common.reports"),
      path: "/reports",
      roles: [
        "supervisor",
        "department_manager",
        "hospital_admin",
        "system_admin",
      ],
    },
    {
      icon: FileText,
      label: t("common.audit_log"),
      path: "/audit-log",
      roles: ["hospital_admin", "system_admin"],
    },
    {
      icon: Settings,
      label: t("common.settings"),
      path: "/settings",
      roles: [
        "employee",
        "supervisor",
        "department_manager",
        "hospital_admin",
        "system_admin",
      ],
    },
  ];

  const visibleItems = menuItems.filter((item) => item.roles.includes(role));

  return (
    <div className="flex h-full w-64 flex-col bg-sidebar border-x border-sidebar-border shadow-sm">
      <div className="flex h-16 items-center px-6 border-b border-sidebar-border bg-sidebar-primary text-sidebar-primary-foreground">
        <h1 className="text-xl font-bold tracking-tight">
          {t("auth.brand_name")}
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto py-4">
        <nav className="space-y-1 px-3">
          {visibleItems.map((item) => {
            const isActive =
              location === item.path ||
              (item.path !== "/" && location.startsWith(item.path));
            return (
              <Link
                key={item.path}
                href={item.path}
                onClick={onNavigate}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                )}
              >
                <item.icon className="h-5 w-5" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
            {localizedName?.[0]?.toUpperCase() || "U"}
          </div>
          <div className="flex flex-col overflow-hidden">
            <span className="text-sm font-medium truncate">
              {localizedName || t("common.user")}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {t(`roles.${role}`)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
