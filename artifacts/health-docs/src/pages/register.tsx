import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  useAcceptEmployeeInvitation,
} from "@workspace/api-client-react";
import { KeyRound, Languages, MailCheck, ShieldCheck } from "lucide-react";
import { Link } from "wouter";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/lib/language-context";
import {
  consumeRegistrationToken,
  focusRegistrationSuccess,
  getRegistrationPasswordError,
} from "./register-state";

export default function Register() {
  const { t, language, setLanguage } = useLanguage();
  // The invitation secret exists only in this component's memory. Scrub the
  // fragment before the first user interaction and never put it in browser
  // storage, application logs, or another URL.
  const [token, setToken] = useState(() =>
    consumeRegistrationToken(window.location, window.history),
  );
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [feedbackKey, setFeedbackKey] = useState<string | null>(null);
  const [registrationComplete, setRegistrationComplete] = useState(false);
  const [invitationInvalid, setInvitationInvalid] = useState(false);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const acceptInvitation = useAcceptEmployeeInvitation({
    mutation: { gcTime: 0 },
  });
  const linkInvalid = !token && !registrationComplete;

  useEffect(() => {
    focusRegistrationSuccess(registrationComplete, successHeadingRef.current);
  }, [registrationComplete]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = getRegistrationPasswordError(
      password,
      confirmation,
    );
    if (validationError) {
      setFeedbackKey(
        validationError === "mismatch"
          ? "register.mismatch"
          : "register.weak_password",
      );
      return;
    }

    setFeedbackKey(null);
    acceptInvitation.mutate(
      { data: { token, password } },
      {
        onSuccess: () => {
          setToken("");
          setPassword("");
          setConfirmation("");
          acceptInvitation.reset();
          setRegistrationComplete(true);
        },
        onError: (error: unknown) => {
          const code =
            error instanceof ApiError
              ? (error.data as { code?: string } | null)?.code
              : undefined;
          setPassword("");
          setConfirmation("");
          acceptInvitation.reset();
          if (code === "weak_password") {
            setFeedbackKey("register.weak_password");
            return;
          }
          if (code === "invalid_invitation") {
            setInvitationInvalid(true);
            setToken("");
          }
          setFeedbackKey(
            code === "invalid_invitation"
              ? "register.invalid_hint"
              : "register.failed",
          );
        },
      },
    );
  };

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-md space-y-6">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center gap-2 rounded-md text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <ShieldCheck className="h-8 w-8" aria-hidden="true" />
            <span className="font-bold">{t("auth.brand_name")}</span>
          </Link>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 gap-2 px-3"
            onClick={() => setLanguage(language === "ar" ? "en" : "ar")}
            aria-label={t("mobile.change_language")}
          >
            <Languages className="h-4 w-4" aria-hidden="true" />
            <span>{language === "ar" ? "English" : "العربية"}</span>
          </Button>
        </div>

        <Card className="overflow-hidden shadow-sm">
          <CardContent className="space-y-6 p-5 sm:p-8">
            <div
              className="space-y-3 text-center"
              role={registrationComplete ? "status" : undefined}
              aria-live={registrationComplete ? "polite" : undefined}
              aria-atomic={registrationComplete ? "true" : undefined}
            >
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                {registrationComplete ? (
                  <MailCheck className="h-7 w-7" aria-hidden="true" />
                ) : (
                  <KeyRound className="h-7 w-7" aria-hidden="true" />
                )}
              </span>
              <h1
                ref={successHeadingRef}
                tabIndex={registrationComplete ? -1 : undefined}
                className="rounded-sm text-2xl font-bold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 sm:text-3xl"
              >
                {registrationComplete
                  ? t("register.success_title")
                  : linkInvalid
                    ? t(
                        invitationInvalid
                          ? "register.invalid_title"
                          : "register.invitation_required_title",
                      )
                    : t("register.title")}
              </h1>
              <p className="text-sm leading-6 text-muted-foreground sm:text-base">
                {registrationComplete
                  ? t("register.success_message")
                  : linkInvalid
                    ? t(
                        invitationInvalid
                          ? "register.invalid_hint"
                          : "register.no_invitation_hint",
                      )
                    : t("register.subtitle")}
              </p>
            </div>

            {registrationComplete || linkInvalid ? (
              <Button
                asChild
                className="min-h-12 w-full text-base font-semibold"
              >
                <Link href="/login">{t("register.login_action")}</Link>
              </Button>
            ) : (
              <>
                <p
                  id="registration-invitation-notice"
                  className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6 text-muted-foreground"
                >
                  {t("register.invitation_required")}
                </p>
                <form
                  onSubmit={handleSubmit}
                  className="space-y-5"
                  aria-describedby="registration-invitation-notice"
                >
                  <div className="space-y-2">
                    <Label htmlFor="registration-password">
                      {t("register.password")}
                    </Label>
                    <Input
                      id="registration-password"
                      type="password"
                      required
                      minLength={12}
                      autoComplete="new-password"
                      dir="ltr"
                      className="min-h-11"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setFeedbackKey(null);
                      }}
                      aria-describedby="registration-password-hint"
                    />
                    <p
                      id="registration-password-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {t("register.password_hint")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="registration-password-confirmation">
                      {t("register.confirm_password")}
                    </Label>
                    <Input
                      id="registration-password-confirmation"
                      type="password"
                      required
                      minLength={12}
                      autoComplete="new-password"
                      dir="ltr"
                      className="min-h-11"
                      value={confirmation}
                      onChange={(event) => {
                        setConfirmation(event.target.value);
                        setFeedbackKey(null);
                      }}
                    />
                  </div>

                  {feedbackKey && (
                    <p
                      className="rounded-lg bg-destructive/10 p-3 text-sm leading-6 text-destructive"
                      role="alert"
                      aria-live="assertive"
                    >
                      {t(feedbackKey)}
                    </p>
                  )}

                  <Button
                    type="submit"
                    className="min-h-12 w-full text-base font-semibold"
                    disabled={acceptInvitation.isPending}
                  >
                    {acceptInvitation.isPending
                      ? t("common.loading")
                      : t("register.submit")}
                  </Button>
                </form>
              </>
            )}
          </CardContent>
        </Card>

        <div className="text-center">
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t("forgot_password.back_to_login")}
          </Link>
        </div>
      </div>
    </main>
  );
}
