import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  useTotpChallenge,
  ApiError,
} from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { setAuthSession } from "@/lib/auth";
import { authenticatedLandingPath } from "@/lib/password-change-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";

export const TWOFA_CHALLENGE_KEY = "healthdocs_2fa_challenge";

/**
 * Second step of login for 2FA accounts. The password step stored a
 * short-lived challenge token in sessionStorage; here the user provides the
 * 6-digit authenticator code (or a single-use backup code) to get a session.
 */
export default function TwoFactorChallenge() {
  const { t } = useLanguage();
  const [, setLocation] = useLocation();
  const [challengeToken] = useState(() => {
    // An external authentication flow may hand the challenge token over in the URL fragment
    // (#ct=…): fragments never reach servers, logs or Referer headers. Move
    // it into sessionStorage and scrub the address bar immediately.
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("ct");
    if (fromHash) {
      sessionStorage.setItem(TWOFA_CHALLENGE_KEY, fromHash);
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      return fromHash;
    }
    return sessionStorage.getItem(TWOFA_CHALLENGE_KEY) ?? "";
  });
  const [otp, setOtp] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const challengeMutation = useTotpChallenge();

  useEffect(() => {
    if (!challengeToken) setLocation("/login");
  }, [challengeToken, setLocation]);

  if (!challengeToken) return null;

  const backToLogin = () => {
    sessionStorage.removeItem(TWOFA_CHALLENGE_KEY);
    setLocation("/login");
  };

  const submit = (code: string) => {
    if (!code || challengeMutation.isPending) return;
    challengeMutation.mutate(
      { data: { challengeToken, code } },
      {
        onSuccess: (res) => {
          sessionStorage.removeItem(TWOFA_CHALLENGE_KEY);
          setAuthSession(res.user);
          toast.success(t("auth.welcome_back"));
          setLocation(authenticatedLandingPath(res.user));
        },
        onError: (err) => {
          const code =
            err instanceof ApiError
              ? (err.data as { code?: string } | null)?.code
              : undefined;
          if (code === "invalid_code") {
            toast.error(t("twofa.invalid_code"));
            setOtp("");
            return;
          }
          if (code === "too_many_attempts") {
            toast.error(t("twofa.too_many_attempts"));
          } else {
            toast.error(t("twofa.challenge_expired"));
          }
          backToLogin();
        },
      },
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit(useBackup ? backupCode : otp);
  };

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center text-primary mb-4">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight">
            {t("twofa.challenge_title")}
          </h2>
          <p className="text-muted-foreground">
            {useBackup
              ? t("twofa.challenge_backup_subtitle")
              : t("twofa.challenge_subtitle")}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {useBackup ? (
            <Input
              value={backupCode}
              onChange={(e) => setBackupCode(e.target.value)}
              placeholder="XXXXX-XXXXX"
              dir="ltr"
              autoFocus
              className="h-12 text-center font-mono tracking-widest"
            />
          ) : (
            <div className="flex justify-center" dir="ltr">
              <InputOTP
                maxLength={6}
                value={otp}
                onChange={setOtp}
                onComplete={(value: string) => submit(value)}
                autoFocus
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <InputOTPSlot key={i} index={i} className="h-12 w-12 text-lg" />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
          )}

          <Button
            type="submit"
            className="w-full h-11 text-lg font-semibold"
            disabled={
              challengeMutation.isPending || (useBackup ? !backupCode : otp.length < 6)
            }
          >
            {challengeMutation.isPending ? t("common.loading") : t("twofa.verify")}
          </Button>
        </form>

        <div className="flex flex-col items-center gap-3 text-sm">
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => setUseBackup((v) => !v)}
          >
            {useBackup ? t("twofa.use_otp") : t("twofa.use_backup")}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:underline"
            onClick={backToLogin}
          >
            {t("twofa.back_to_login")}
          </button>
        </div>
      </div>
    </div>
  );
}
