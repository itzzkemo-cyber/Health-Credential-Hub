import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useLogin, type AuthResponse } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { setAuthSession } from "@/lib/auth";
import { authenticatedLandingPath } from "@/lib/password-change-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Languages, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

export default function Login() {
  const { t, language, setLanguage } = useLanguage();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const loginMutation = useLogin();

  // The API sets the session only as an httpOnly cookie. The response carries
  // the non-sensitive user profile so the web UI can choose the next screen.
  const onAuthenticated = (res: AuthResponse) => {
    setAuthSession(res.user);
    toast.success(t("auth.welcome_back"));
    setLocation(authenticatedLandingPath(res.user));
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

  return (
    <div className="min-h-[100dvh] bg-background">
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
            <div className="grid grid-cols-1 gap-4 pt-12 sm:grid-cols-3">
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
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-primary md:hidden">
                <ShieldCheck className="h-9 w-9" aria-hidden="true" />
                <span className="text-xl font-bold sm:text-2xl">
                  {t("auth.brand_name")}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="ms-auto min-h-11 gap-2 px-3"
                onClick={() => setLanguage(language === "ar" ? "en" : "ar")}
                aria-label={t("mobile.change_language")}
              >
                <Languages className="h-4 w-4" aria-hidden="true" />
                <span>{language === "ar" ? "English" : "العربية"}</span>
              </Button>
            </div>
            <div className="text-center md:text-start space-y-2">
              <h2 className="text-2xl font-bold sm:text-3xl">
                {t("auth.login")}
              </h2>
              <p className="text-muted-foreground">
                {t("auth.login_subtitle")}
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t("auth.email")}</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    autoComplete="username"
                    placeholder="name@hospital.sa"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    dir="ltr"
                    className="h-11"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="password">{t("auth.password")}</Label>
                    <Link
                      href="/forgot-password"
                      className="inline-flex min-h-11 items-center rounded-sm text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      {t("auth.forgot_password")}
                    </Link>
                  </div>
                  <Input
                    id="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    dir="ltr"
                    className="h-11"
                  />
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
            <div className="rounded-xl border bg-muted/30 p-4 text-center">
              <p className="text-sm leading-6 text-muted-foreground">
                {t("auth.employee_registration_hint")}
              </p>
              <Button
                asChild
                variant="link"
                className="min-h-11 px-2 font-semibold"
              >
                <Link href="/register">{t("auth.employee_registration")}</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
