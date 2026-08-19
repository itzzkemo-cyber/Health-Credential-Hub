import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import {
  useLogin,
  useDemoLogin,
  type DemoLoginInputRole,
  type AuthResponse,
} from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { setAuthSession } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ShieldCheck,
  UserCircle,
  Users,
  Activity,
  HeartPulse,
} from "lucide-react";
import { toast } from "sonner";
import { ShowcaseBanner } from "@/components/layout/ShowcaseBanner";
import { isShowcaseMode } from "@/demo/showcase";

// Failure codes the Google OAuth callback may append as ?error=… on its
// redirect back to this page, mapped to localized toasts.
const GOOGLE_ERROR_KEYS: Record<string, string> = {
  oauth_config: "auth.google_error_config",
  oauth_state: "auth.google_error_failed",
  oauth_failed: "auth.google_error_failed",
  oauth_denied: "auth.google_error_denied",
  oauth_email_unverified: "auth.google_error_unverified",
  oauth_inactive: "auth.google_error_inactive",
};

// Official multi-color "G" — Google's brand rules require it on the button.
const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

export default function Login() {
  const { t } = useLanguage();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const loginMutation = useLogin();
  const demoLoginMutation = useDemoLogin();

  // Surface a failed Google sign-in (the callback redirects with ?error=…).
  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get("error");
    if (error) {
      toast.error(t(GOOGLE_ERROR_KEYS[error] ?? "auth.google_error_failed"));
      history.replaceState(null, "", window.location.pathname);
    }
    // Run once on mount — the toast must not repeat on language switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startGoogleLogin = () => {
    if (isShowcaseMode) {
      toast.info(t("showcase.external_disabled"));
      return;
    }
    // Google refuses to render its consent screen inside an iframe (the
    // Replit preview pane) — open a tab there; navigate in place otherwise.
    const url = "/api/auth/google";
    if (window.self !== window.top) window.open(url, "_blank");
    else window.location.assign(url);
  };

  // The API sets the session as an httpOnly cookie; the response body's
  // token is for native clients only and is deliberately not stored here.
  const onAuthenticated = (res: AuthResponse) => {
    setAuthSession(res.user);
    toast.success(t("auth.welcome_back"));
    setLocation("/");
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate(
      { data: { email, password } },
      {
        onSuccess: (res) => {
          // 2FA accounts get a challenge token instead of a session (202).
          if ("pending2fa" in res) {
            sessionStorage.setItem(
              "healthdocs_2fa_challenge",
              res.challengeToken,
            );
            setLocation("/2fa-challenge");
            return;
          }
          onAuthenticated(res);
        },
        onError: () => {
          toast.error(t("auth.invalid_credentials"));
        },
      },
    );
  };

  // Demo sign-in happens server-side: the client only knows role names,
  // never passwords (nothing secret ships in the JS bundle).
  const demoAccounts: {
    role: DemoLoginInputRole;
    email: string;
    icon: typeof ShieldCheck;
    color: string;
  }[] = [
    {
      role: "system_admin",
      email: "admin@healthdocs.sa",
      icon: ShieldCheck,
      color: "text-red-500",
    },
    {
      role: "hospital_admin",
      email: "hospital@healthdocs.sa",
      icon: Activity,
      color: "text-blue-500",
    },
    {
      role: "department_manager",
      email: "dept@healthdocs.sa",
      icon: Users,
      color: "text-amber-500",
    },
    {
      role: "supervisor",
      email: "supervisor@healthdocs.sa",
      icon: HeartPulse,
      color: "text-green-500",
    },
    {
      role: "employee",
      email: "employee@healthdocs.sa",
      icon: UserCircle,
      color: "text-primary",
    },
  ];

  const handleDemoLogin = (role: DemoLoginInputRole) => {
    demoLoginMutation.mutate(
      { data: { role } },
      {
        onSuccess: onAuthenticated,
        onError: () => {
          toast.error(t("auth.invalid_credentials"));
        },
      },
    );
  };
  const visibleDemoAccounts = isShowcaseMode
    ? demoAccounts.filter((account) => account.role === "employee")
    : demoAccounts;

  return (
    <div className="min-h-[100dvh] bg-background">
      <ShowcaseBanner />
      <div className="flex min-h-[calc(100dvh-0px)] flex-col md:flex-row">
        {/* Left side - Brand/Info */}
        <div className="hidden md:flex md:w-1/2 lg:w-[60%] bg-primary/5 flex-col justify-center items-center p-12 relative overflow-hidden">
          <div className="absolute inset-0 bg-primary/10 [mask-image:linear-gradient(to_bottom,white,transparent)] pointer-events-none" />
          <div className="max-w-xl z-10 text-center space-y-6">
            <div className="flex items-center justify-center gap-3 text-primary mb-8">
              <ShieldCheck className="h-16 w-16" />
              <h1 className="text-5xl font-bold tracking-tight">
                {t("auth.brand_name")}
              </h1>
            </div>
            <p className="text-2xl text-muted-foreground/80 font-medium">
              {t("auth.system_title")}
            </p>
            <div className="grid grid-cols-2 gap-4 pt-12">
              <div className="bg-background/60 p-6 rounded-2xl border backdrop-blur-sm">
                <h3 className="font-semibold text-lg mb-2">
                  {t("auth.feature_compliance")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("auth.feature_compliance_desc")}
                </p>
              </div>
              <div className="bg-background/60 p-6 rounded-2xl border backdrop-blur-sm">
                <h3 className="font-semibold text-lg mb-2">
                  {t("auth.feature_ocr")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("auth.feature_ocr_desc")}
                </p>
              </div>
              <div className="bg-background/60 p-6 rounded-2xl border backdrop-blur-sm">
                <h3 className="font-semibold text-lg mb-2">
                  {t("auth.feature_qr")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("auth.feature_qr_desc")}
                </p>
              </div>
              <div className="bg-background/60 p-6 rounded-2xl border backdrop-blur-sm">
                <h3 className="font-semibold text-lg mb-2">
                  {t("auth.feature_alerts")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("auth.feature_alerts_desc")}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right side - Login Form */}
        <div className="flex w-full flex-col justify-center px-4 py-8 sm:px-8 md:w-1/2 md:px-12 md:py-12 lg:w-[40%] lg:px-16">
          <div className="mx-auto w-full max-w-md space-y-7 sm:space-y-8">
            <div className="flex items-center justify-center gap-2 text-primary md:hidden">
              <ShieldCheck className="h-9 w-9" aria-hidden="true" />
              <span className="text-2xl font-bold">{t("auth.brand_name")}</span>
            </div>
            <div className="text-center md:text-start space-y-2">
              <h2 className="text-2xl font-bold sm:text-3xl">
                {t("auth.login")}
              </h2>
              <p className="text-muted-foreground">
                {t("auth.login_subtitle")}
              </p>
            </div>

            {!isShowcaseMode && (
              <>
                <form onSubmit={handleLogin} className="space-y-6">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="email">{t("auth.email")}</Label>
                      <Input
                        id="email"
                        type="email"
                        required
                        placeholder="name@hospital.sa"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        dir="ltr"
                        className="h-11"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="password">{t("auth.password")}</Label>
                        <Link
                          href="/forgot-password"
                          className="text-sm text-primary hover:underline"
                        >
                          {t("auth.forgot_password")}
                        </Link>
                      </div>
                      <Input
                        id="password"
                        type="password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        dir="ltr"
                        className="h-11"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id="remember" />
                      <label
                        htmlFor="remember"
                        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                      >
                        {t("auth.remember_me")}
                      </label>
                    </div>
                  </div>
                  <Button
                    type="submit"
                    className="min-h-12 w-full text-base font-semibold sm:text-lg"
                    disabled={loginMutation.isPending}
                  >
                    {loginMutation.isPending
                      ? t("common.loading")
                      : t("auth.login_button")}
                  </Button>
                </form>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-background px-3 text-muted-foreground">
                      {t("auth.google_or")}
                    </span>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="w-full h-11 font-medium gap-3 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:bg-white dark:text-slate-700 dark:hover:bg-slate-100 border-slate-200"
                  onClick={startGoogleLogin}
                >
                  <GoogleIcon />
                  {t("auth.google_button")}
                </Button>

                <p className="text-center text-sm text-muted-foreground">
                  {t("auth.no_account")}{" "}
                  <Link
                    href="/register"
                    className="text-primary hover:underline font-medium"
                  >
                    {t("auth.create_account")}
                  </Link>
                </p>
              </>
            )}

            <div className="pt-8 border-t space-y-4">
              <p className="text-sm text-muted-foreground text-center font-medium">
                {t(
                  isShowcaseMode
                    ? "showcase.employee_demo"
                    : "auth.demo_accounts",
                )}
              </p>
              <div className="grid gap-2">
                {visibleDemoAccounts.map((demo) => (
                  <button
                    key={demo.role}
                    type="button"
                    disabled={demoLoginMutation.isPending}
                    onClick={() => handleDemoLogin(demo.role)}
                    className="flex min-h-14 flex-col items-start justify-between gap-1 rounded-lg border bg-card p-3 text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60 sm:flex-row sm:items-center"
                  >
                    <div className="flex items-center gap-3">
                      <demo.icon className={`h-4 w-4 ${demo.color}`} />
                      <span className="font-semibold">
                        {t(`roles.${demo.role}`)}
                      </span>
                    </div>
                    <span
                      className="break-all text-start text-xs text-muted-foreground"
                      dir="ltr"
                    >
                      {demo.email}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
