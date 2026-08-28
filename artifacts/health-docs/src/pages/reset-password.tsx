import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useResetPassword,
  ApiError,
  type AuthResponse,
} from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { setAuthSession } from "@/lib/auth";
import { consumeResetToken } from "@/lib/reset-token";
import { authenticatedLandingPath } from "@/lib/password-change-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, ShieldCheck, ArrowRight, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export default function ResetPassword() {
  const { t } = useLanguage();
  const [, setLocation] = useLocation();
  // Consume the secret into component memory and scrub it from the address
  // bar before any user interaction, render effect, or API request.
  const [token] = useState(() =>
    consumeResetToken(window.location, window.history),
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [linkInvalid, setLinkInvalid] = useState(!token);
  const resetMutation = useResetPassword();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast.error(t("reset_password.mismatch"));
      return;
    }
    resetMutation.mutate(
      { data: { token, newPassword: password } },
      {
        onSuccess: (res) => {
          // 2FA accounts still need the OTP step after a reset (202).
          if ("pending2fa" in res) {
            sessionStorage.setItem(
              "healthdocs_2fa_challenge",
              res.challengeToken,
            );
            toast.success(t("reset_password.success"));
            setLocation("/2fa-challenge");
            return;
          }
          setAuthSession(res.user);
          toast.success(t("reset_password.success"));
          setLocation(authenticatedLandingPath(res.user));
        },
        onError: (err) => {
          const code =
            err instanceof ApiError
              ? (err.data as { code?: string } | null)?.code
              : undefined;
          if (code === "weak_password") {
            // Token is still fine — only the password was rejected.
            toast.error(t("reset_password.password_hint"));
          } else if (err instanceof ApiError && err.status === 400) {
            setLinkInvalid(true);
          } else {
            toast.error(t("reset_password.invalid_link"));
          }
        },
      },
    );
  };

  const isRTL = document.documentElement.dir === "rtl";
  const ArrowIcon = isRTL ? ArrowRight : ArrowLeft;

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center text-primary mb-4">
            {linkInvalid ? (
              <ShieldCheck className="h-8 w-8" />
            ) : (
              <KeyRound className="h-8 w-8" />
            )}
          </div>
          <h2 className="text-3xl font-bold tracking-tight">
            {linkInvalid
              ? t("reset_password.invalid_link")
              : t("reset_password.title")}
          </h2>
          <p className="text-muted-foreground">
            {linkInvalid
              ? t("reset_password.invalid_link_hint")
              : t("reset_password.subtitle")}
          </p>
        </div>

        {linkInvalid ? (
          <div className="bg-card p-8 rounded-2xl border shadow-sm flex flex-col items-center text-center space-y-4">
            <Button asChild className="w-full h-11 text-lg font-semibold">
              <Link href="/forgot-password">
                {t("reset_password.request_new")}
              </Link>
            </Button>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="space-y-6 bg-card p-8 rounded-2xl border shadow-sm"
          >
            <div className="space-y-2">
              <Label htmlFor="password">
                {t("reset_password.new_password")}
              </Label>
              <Input
                id="password"
                type="password"
                required
                minLength={12}
                maxLength={1024}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
                className="h-11"
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {t("reset_password.password_hint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">
                {t("reset_password.confirm_password")}
              </Label>
              <Input
                id="confirm"
                type="password"
                required
                minLength={12}
                maxLength={1024}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                dir="ltr"
                className="h-11"
                autoComplete="new-password"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 text-lg font-semibold"
              disabled={resetMutation.isPending}
            >
              {resetMutation.isPending
                ? t("common.loading")
                : t("reset_password.submit")}
            </Button>
          </form>
        )}

        <div className="text-center">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-sm text-primary hover:underline font-medium"
          >
            <ArrowIcon className="h-4 w-4" />
            {t("forgot_password.back_to_login")}
          </Link>
        </div>
      </div>
    </div>
  );
}
