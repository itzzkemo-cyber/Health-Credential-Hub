import { useState } from "react";
import { useLocation } from "wouter";
import { ApiError, useChangePassword } from "@workspace/api-client-react";
import { toast } from "sonner";

import { useLanguage } from "@/lib/language-context";
import { getAuthUser, setAuthSession } from "@/lib/auth";
import {
  authenticatedLandingPath,
  mustReplaceTemporaryPassword,
  withPasswordChangeState,
  type AccountSetupUser,
} from "@/lib/password-change-state";
import { mustEnrollPrivilegedMfa } from "@/lib/account-security-state";
import { useTheme } from "@/components/theme-provider";
import TwoFactorCard from "@/components/settings/TwoFactorCard";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, EyeOff, Globe, KeyRound, Loader2, Moon } from "lucide-react";

export default function Settings() {
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme } = useTheme();
  const user = getAuthUser() as AccountSetupUser | null;
  const mustChangePassword = mustReplaceTemporaryPassword(user);
  const mfaEnrollmentRequired = mustEnrollPrivilegedMfa(user);

  if (mustChangePassword) {
    return (
      <div className="space-y-6 animate-in fade-in duration-300">
        <div className="space-y-2 text-center sm:text-start">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {t("settings_page.password_required_title")}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground sm:text-base">
            {t("settings_page.password_required_desc")}
          </p>
        </div>
        <ChangePasswordCard forced />
      </div>
    );
  }

  if (mfaEnrollmentRequired) {
    return (
      <div className="space-y-6 animate-in fade-in duration-300">
        <div
          className="space-y-2 text-center sm:text-start"
          role="status"
          aria-live="polite"
        >
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {t("settings_page.mfa_required_title")}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground sm:text-base">
            {t("settings_page.mfa_required_desc")}
          </p>
        </div>
        <TwoFactorCard />
        <p className="text-sm leading-6 text-muted-foreground">
          {t("settings_page.mfa_required_hint")}
        </p>
      </div>
    );
  }

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
        <ChangePasswordCard />

        <TwoFactorCard />

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

        <p className="text-sm leading-6 text-muted-foreground">
          {t("settings_page.applies_immediately")}
        </p>
      </div>
    </div>
  );
}

function ChangePasswordCard({ forced = false }: { forced?: boolean }) {
  const { t } = useLanguage();
  const [, setLocation] = useLocation();
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState({
    current: false,
    next: false,
    confirm: false,
  });

  const clearError = () => {
    setValidationError(null);
    changePassword.reset();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 12) {
      setValidationError("settings_page.password_minimum");
      return;
    }
    if (newPassword !== confirmPassword) {
      setValidationError("settings_page.password_mismatch");
      return;
    }

    setValidationError(null);
    changePassword.mutate(
      { data: { currentPassword, newPassword } },
      {
        onSuccess: () => {
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
          setVisiblePasswords({ current: false, next: false, confirm: false });
          const user = getAuthUser() as AccountSetupUser | null;
          const updatedUser = user
            ? withPasswordChangeState(user, false)
            : null;
          if (updatedUser) setAuthSession(updatedUser);
          const needsMfa = mustEnrollPrivilegedMfa(updatedUser);
          toast.success(
            t(
              forced
                ? needsMfa
                  ? "settings_page.password_required_mfa_next"
                  : "settings_page.password_required_success"
                : "settings_page.password_changed",
            ),
          );
          if (forced) {
            setLocation(
              updatedUser ? authenticatedLandingPath(updatedUser) : "/settings",
            );
          }
        },
      },
    );
  };

  const mutationCode =
    changePassword.error instanceof ApiError
      ? (changePassword.error.data as { code?: string } | null)?.code
      : undefined;
  const mutationError =
    mutationCode === "PASSWORD_REUSE_NOT_ALLOWED"
      ? "settings_page.password_reuse_not_allowed"
      : changePassword.error instanceof ApiError && changePassword.error.status === 400
        ? "settings_page.current_password_incorrect"
      : changePassword.error instanceof ApiError &&
          changePassword.error.status === 429
        ? "settings_page.password_rate_limited"
        : "settings_page.password_change_failed";
  const errorKey = validationError ?? (changePassword.isError ? mutationError : null);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
          <CardTitle>{t("settings_page.change_password")}</CardTitle>
        </div>
        <CardDescription>
          {t(
            forced
              ? "settings_page.password_required_card_desc"
              : "settings_page.change_password_desc",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <PasswordField
            id="current-password"
            label={t("settings_page.current_password")}
            value={currentPassword}
            onChange={(value) => {
              clearError();
              setCurrentPassword(value);
            }}
            visible={visiblePasswords.current}
            onToggle={() =>
              setVisiblePasswords((previous) => ({
                ...previous,
                current: !previous.current,
              }))
            }
            showLabel={t("settings_page.show_password")}
            hideLabel={t("settings_page.hide_password")}
            autoComplete="current-password"
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PasswordField
              id="new-password"
              label={t("settings_page.new_password")}
              value={newPassword}
              onChange={(value) => {
                clearError();
                setNewPassword(value);
              }}
              visible={visiblePasswords.next}
              onToggle={() =>
                setVisiblePasswords((previous) => ({
                  ...previous,
                  next: !previous.next,
                }))
              }
              showLabel={t("settings_page.show_password")}
              hideLabel={t("settings_page.hide_password")}
              autoComplete="new-password"
              minLength={12}
            />
            <PasswordField
              id="confirm-new-password"
              label={t("settings_page.confirm_password")}
              value={confirmPassword}
              onChange={(value) => {
                clearError();
                setConfirmPassword(value);
              }}
              visible={visiblePasswords.confirm}
              onToggle={() =>
                setVisiblePasswords((previous) => ({
                  ...previous,
                  confirm: !previous.confirm,
                }))
              }
              showLabel={t("settings_page.show_password")}
              hideLabel={t("settings_page.hide_password")}
              autoComplete="new-password"
              minLength={12}
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("settings_page.password_minimum")}
          </p>
          {errorKey && (
            <p
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {t(errorKey)}
            </p>
          )}
          <Button
            type="submit"
            disabled={changePassword.isPending}
            className="min-h-11 w-full gap-2 sm:w-auto"
          >
            {changePassword.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {t("settings_page.save_password")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  visible,
  onToggle,
  showLabel,
  hideLabel,
  autoComplete,
  minLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          minLength={minLength}
          autoComplete={autoComplete}
          dir="ltr"
          className="min-h-11 pe-12"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute end-0 top-0 h-11 w-11"
          onClick={onToggle}
          aria-label={visible ? hideLabel : showLabel}
        >
          {visible ? (
            <EyeOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Eye className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}
