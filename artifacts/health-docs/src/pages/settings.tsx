import { useLanguage } from "@/lib/language-context";
import { useTheme } from "@/components/theme-provider";
import TwoFactorCard from "@/components/settings/TwoFactorCard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Globe, Moon, Bell, ShieldCheck } from "lucide-react";
import { isShowcaseMode } from "@/demo/showcase";

export default function Settings() {
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme } = useTheme();

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {t("common.settings")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground sm:text-base">
          {t("settings_page.subtitle")}
        </p>
      </div>

      <div className="grid gap-6">
        {isShowcaseMode ? (
          <Card className="border-amber-300/60 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20">
            <CardContent className="flex items-start gap-3 p-5 text-sm leading-6 text-muted-foreground">
              <ShieldCheck
                className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300"
                aria-hidden="true"
              />
              <p>{t("showcase.security_settings_disabled")}</p>
            </CardContent>
          </Card>
        ) : (
          <TwoFactorCard />
        )}

        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              <CardTitle>{t("settings_page.language_region")}</CardTitle>
            </div>
            <CardDescription>
              {t("settings_page.language_region_desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="interface-language">
                  {t("settings_page.interface_language")}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t("settings_page.interface_language_desc")}
                </p>
              </div>
              <Select
                value={language}
                onValueChange={(v) => setLanguage(v as "ar" | "en")}
              >
                <SelectTrigger
                  id="interface-language"
                  className="min-h-11 w-full sm:w-[180px]"
                >
                  <SelectValue
                    placeholder={t("settings_page.interface_language")}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ar">العربية (Arabic)</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="hijri-calendar">
                  {t("settings_page.calendar")}
                </Label>
                <p
                  id="hijri-calendar-description"
                  className="text-sm text-muted-foreground"
                >
                  {t("settings_page.calendar_desc")}
                  {" "}
                  {t("settings_page.not_available")}
                </p>
              </div>
              <Switch
                id="hijri-calendar"
                disabled
                aria-describedby="hijri-calendar-description"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Moon className="h-5 w-5 text-primary" />
              <CardTitle>{t("settings_page.appearance")}</CardTitle>
            </div>
            <CardDescription>
              {t("settings_page.appearance_desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="interface-theme">
                  {t("settings_page.theme")}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t("settings_page.theme_desc")}
                </p>
              </div>
              <Select value={theme} onValueChange={(v) => setTheme(v as any)}>
                <SelectTrigger
                  id="interface-theme"
                  className="min-h-11 w-full sm:w-[180px]"
                >
                  <SelectValue placeholder={t("settings_page.theme")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">
                    {t("settings_page.light")}
                  </SelectItem>
                  <SelectItem value="dark">
                    {t("settings_page.dark")}
                  </SelectItem>
                  <SelectItem value="system">
                    {t("settings_page.system")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-primary" />
              <CardTitle>{t("settings_page.notifications")}</CardTitle>
            </div>
            <CardDescription>
              {t("settings_page.notifications_desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="expiry-email-warnings">
                  {t("settings_page.expiry_warnings")}
                </Label>
                <p
                  id="expiry-email-warnings-description"
                  className="text-sm text-muted-foreground"
                >
                  {t("settings_page.expiry_warnings_desc")}
                </p>
              </div>
              <Switch
                id="expiry-email-warnings"
                disabled
                aria-describedby="expiry-email-warnings-description"
              />
            </div>

            <div className="space-y-3 pt-4 border-t border-border">
              <p className="text-sm leading-6 text-muted-foreground">
                {t("settings_page.alerts_managed_by_admin")}
              </p>
            </div>
          </CardContent>
        </Card>

        <p className="text-sm leading-6 text-muted-foreground">
          {t("settings_page.applies_immediately")}
        </p>
      </div>
    </div>
  );
}
