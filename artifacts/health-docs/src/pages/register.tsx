import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  useAcceptEmployeeInvitation,
  useStartInvitationEmailVerification,
} from "@workspace/api-client-react";
import {
  KeyRound,
  Languages,
  Mail,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import { Link } from "wouter";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/lib/language-context";
import {
  consumeRegistrationToken,
  createRegistrationEmailOtpStart,
  createRegistrationSubmission,
  focusRegistrationSuccess,
  getRegistrationApiFailure,
  getRegistrationEmailOtpStartFailure,
  getRegistrationResendSeconds,
  isRegistrationOtpComplete,
  normalizeRegistrationOtp,
  REGISTRATION_OTP_LENGTH,
  REGISTRATION_PASSWORD_MAX_LENGTH,
} from "./register-state";

type RegistrationStep = "email" | "code" | "password";

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function Register() {
  const { t, language, setLanguage } = useLanguage();
  // The invitation secret exists only in this component's memory. Scrub the
  // fragment before the first user interaction and never put it in browser
  // storage, application logs, or another URL.
  const [token, setToken] = useState(() =>
    consumeRegistrationToken(window.location, window.history),
  );
  const [step, setStep] = useState<RegistrationStep>("email");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [feedbackKey, setFeedbackKey] = useState<string | null>(null);
  const [announcementKey, setAnnouncementKey] = useState<string | null>(null);
  const [registrationComplete, setRegistrationComplete] = useState(false);
  const [invitationInvalid, setInvitationInvalid] = useState(false);
  const [resendDeadlineMs, setResendDeadlineMs] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const startEmailOtp = useStartInvitationEmailVerification({
    mutation: { gcTime: 0 },
  });
  const acceptInvitation = useAcceptEmployeeInvitation({
    mutation: { gcTime: 0 },
  });
  const linkInvalid = !token && !registrationComplete;
  const resendSeconds = getRegistrationResendSeconds(resendDeadlineMs, nowMs);

  useEffect(() => {
    focusRegistrationSuccess(registrationComplete, successHeadingRef.current);
  }, [registrationComplete]);

  useEffect(() => {
    if (resendDeadlineMs <= Date.now()) return;
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNowMs(currentTime);
      if (currentTime >= resendDeadlineMs) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [resendDeadlineMs]);

  const clearFeedback = () => {
    setFeedbackKey(null);
    setAnnouncementKey(null);
  };

  const invalidateInvitation = () => {
    setInvitationInvalid(true);
    setToken("");
    setOtp("");
    setPassword("");
    setConfirmation("");
  };

  const requestEmailOtp = (isResend: boolean) => {
    if (startEmailOtp.isPending || resendSeconds > 0) return;

    const submission = createRegistrationEmailOtpStart(token);
    if (!submission.ok) {
      setFeedbackKey(submission.feedbackKey);
      setAnnouncementKey(null);
      return;
    }

    clearFeedback();
    startEmailOtp.mutate(
      { data: submission.data },
      {
        onSuccess: (result) => {
          const currentTime = Date.now();
          setNowMs(currentTime);
          setResendDeadlineMs(currentTime + result.retryAfterSeconds * 1_000);
          setOtp("");
          setStep("code");
          startEmailOtp.reset();
          setAnnouncementKey(isResend ? "register.code_sent" : null);
        },
        onError: (error: unknown) => {
          const data =
            error instanceof ApiError
              ? (error.data as {
                  code?: string;
                  retryAfterSeconds?: number;
                } | null)
              : null;
          const retryAfterHeader =
            error instanceof ApiError
              ? Number(error.headers.get("Retry-After"))
              : Number.NaN;
          const retryAfterSeconds =
            typeof data?.retryAfterSeconds === "number"
              ? data.retryAfterSeconds
              : Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
                ? retryAfterHeader
                : undefined;
          const failure = getRegistrationEmailOtpStartFailure(
            data?.code,
            retryAfterSeconds,
          );

          if (failure.invalidatesInvitation) invalidateInvitation();
          if (failure.retryAfterSeconds) {
            const currentTime = Date.now();
            setNowMs(currentTime);
            setResendDeadlineMs(
              currentTime + failure.retryAfterSeconds * 1_000,
            );
          }
          if (data?.code === "otp_already_approved") {
            setStep("code");
          }
          startEmailOtp.reset();
          setAnnouncementKey(null);
          setFeedbackKey(failure.feedbackKey);
        },
      },
    );
  };

  const handleEmailSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    requestEmailOtp(false);
  };

  const handleCodeSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isRegistrationOtpComplete(otp)) {
      setFeedbackKey("register.invalid_email_otp");
      setAnnouncementKey(null);
      return;
    }
    clearFeedback();
    setStep("password");
  };

  const handleRegistrationSubmit = (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const submission = createRegistrationSubmission(
      token,
      password,
      confirmation,
      otp,
    );
    if (!submission.ok) {
      setFeedbackKey(submission.feedbackKey);
      return;
    }

    clearFeedback();
    acceptInvitation.mutate(
      { data: submission.data },
      {
        onSuccess: () => {
          setToken("");
          setOtp("");
          setPassword("");
          setConfirmation("");
          setResendDeadlineMs(0);
          acceptInvitation.reset();
          setRegistrationComplete(true);
        },
        onError: (error: unknown) => {
          const data =
            error instanceof ApiError
              ? (error.data as {
                  code?: string;
                  retryAfterSeconds?: number;
                } | null)
              : null;
          const code = data?.code;
          const failure = getRegistrationApiFailure(code);
          const retryAfterHeader =
            error instanceof ApiError
              ? Number(error.headers.get("Retry-After"))
              : Number.NaN;
          const retryAfterSeconds =
            typeof data?.retryAfterSeconds === "number"
              ? data.retryAfterSeconds
              : Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
                ? retryAfterHeader
                : undefined;
          setPassword("");
          setConfirmation("");
          acceptInvitation.reset();
          if (failure.invalidatesInvitation) {
            invalidateInvitation();
          } else if (
            code === "invalid_email_otp" ||
            code === "otp_rate_limited" ||
            code === "rate_limited" ||
            code === "otp_state_changed" ||
            code === "otp_provider_failed" ||
            code === "otp_unavailable"
          ) {
            if (
              code === "invalid_email_otp" ||
              code === "otp_rate_limited" ||
              code === "rate_limited" ||
              code === "otp_state_changed"
            ) {
              setOtp("");
            }
            setStep("code");
          }
          if (
            (code === "otp_rate_limited" || code === "rate_limited") &&
            typeof retryAfterSeconds === "number" &&
            retryAfterSeconds > 0
          ) {
            const currentTime = Date.now();
            setNowMs(currentTime);
            setResendDeadlineMs(currentTime + retryAfterSeconds * 1_000);
          }
          setFeedbackKey(failure.feedbackKey);
        },
      },
    );
  };

  const activeTitle =
    step === "email"
      ? t("register.email_title")
      : step === "code"
        ? t("register.code_title")
        : t("register.password_title");
  const activeSubtitle =
    step === "email"
      ? t("register.email_subtitle")
      : step === "code"
        ? t("register.code_subtitle")
        : t("register.password_subtitle");

  const feedback = feedbackKey ? (
    <p
      className="rounded-lg bg-destructive/10 p-3 text-sm leading-6 text-destructive"
      role="alert"
      aria-live="assertive"
    >
      {t(feedbackKey)}
    </p>
  ) : null;

  const announcement = announcementKey ? (
    <p
      className="rounded-lg bg-primary/10 p-3 text-sm leading-6 text-primary"
      role="status"
      aria-live="polite"
    >
      {t(announcementKey)}
    </p>
  ) : null;

  return (
    <main className="flex-1 bg-background px-4 py-6 sm:px-6 sm:py-10">
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
                ) : step === "email" || step === "code" ? (
                  <Mail className="h-7 w-7" aria-hidden="true" />
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
                    : activeTitle}
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
                    : activeSubtitle}
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

                {step === "email" && (
                  <form
                    onSubmit={handleEmailSubmit}
                    className="space-y-5"
                    aria-describedby="registration-invitation-notice registration-email-hint"
                  >
                    <div
                      id="registration-email-hint"
                      className="rounded-xl border bg-muted/30 p-4 text-sm leading-6 text-muted-foreground"
                    >
                      {t("register.email_hint")}
                    </div>
                    {feedback}
                    <Button
                      type="submit"
                      className="min-h-12 w-full text-base font-semibold"
                      disabled={startEmailOtp.isPending || resendSeconds > 0}
                    >
                      {startEmailOtp.isPending
                        ? t("common.loading")
                        : t("register.send_code")}
                    </Button>
                    {resendSeconds > 0 && (
                      <p
                        className="text-center text-xs text-muted-foreground"
                        role="timer"
                        aria-live="off"
                      >
                        {t("register.resend_in")}{" "}
                        {formatCountdown(resendSeconds)}
                      </p>
                    )}
                  </form>
                )}

                {step === "code" && (
                  <form
                    onSubmit={handleCodeSubmit}
                    className="space-y-5"
                    aria-describedby="registration-invitation-notice registration-code-hint"
                  >
                    <div className="space-y-3">
                      <Label id="registration-code-label">
                        {t("register.code")}
                      </Label>
                      <div className="flex justify-center" dir="ltr">
                        <InputOTP
                          maxLength={REGISTRATION_OTP_LENGTH}
                          value={otp}
                          onChange={(value) => {
                            setOtp(normalizeRegistrationOtp(value));
                            clearFeedback();
                          }}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          pattern="[0-9]*"
                          aria-labelledby="registration-code-label"
                          aria-describedby="registration-code-hint"
                          autoFocus
                        >
                          <InputOTPGroup>
                            {Array.from(
                              { length: REGISTRATION_OTP_LENGTH },
                              (_, index) => (
                                <InputOTPSlot
                                  key={index}
                                  index={index}
                                  className="h-12 w-11 text-lg sm:w-12"
                                />
                              ),
                            )}
                          </InputOTPGroup>
                        </InputOTP>
                      </div>
                      <p
                        id="registration-code-hint"
                        className="text-center text-xs leading-5 text-muted-foreground"
                      >
                        {t("register.code_hint")}
                      </p>
                    </div>

                    {announcement}
                    {feedback}

                    <Button
                      type="submit"
                      className="min-h-12 w-full text-base font-semibold"
                      disabled={!isRegistrationOtpComplete(otp)}
                    >
                      {t("register.continue_to_password")}
                    </Button>

                    <div className="text-center">
                      <div>
                        <Button
                          type="button"
                          variant="link"
                          className="min-h-11 px-2"
                          disabled={
                            resendSeconds > 0 || startEmailOtp.isPending
                          }
                          onClick={() => requestEmailOtp(true)}
                        >
                          {startEmailOtp.isPending
                            ? t("common.loading")
                            : t("register.resend_code")}
                        </Button>
                        {resendSeconds > 0 && (
                          <p
                            className="text-xs text-muted-foreground"
                            role="timer"
                            aria-live="off"
                          >
                            {t("register.resend_in")}{" "}
                            {formatCountdown(resendSeconds)}
                          </p>
                        )}
                      </div>
                    </div>
                  </form>
                )}

                {step === "password" && (
                  <form
                    onSubmit={handleRegistrationSubmit}
                    className="space-y-5"
                    aria-describedby="registration-invitation-notice registration-password-hint"
                  >
                    <div className="rounded-lg border bg-muted/30 p-3 text-center text-sm leading-6 text-muted-foreground">
                      {t("register.code_entered_pending_verification")}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="registration-password">
                        {t("register.password")}
                      </Label>
                      <Input
                        id="registration-password"
                        type="password"
                        required
                        minLength={12}
                        maxLength={REGISTRATION_PASSWORD_MAX_LENGTH}
                        autoComplete="new-password"
                        dir="ltr"
                        className="min-h-12"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          clearFeedback();
                        }}
                        aria-describedby="registration-password-hint"
                        autoFocus
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
                        maxLength={REGISTRATION_PASSWORD_MAX_LENGTH}
                        autoComplete="new-password"
                        dir="ltr"
                        className="min-h-12"
                        value={confirmation}
                        onChange={(event) => {
                          setConfirmation(event.target.value);
                          clearFeedback();
                        }}
                      />
                    </div>

                    {feedback}

                    <Button
                      type="submit"
                      className="min-h-12 w-full text-base font-semibold"
                      disabled={acceptInvitation.isPending}
                    >
                      {acceptInvitation.isPending
                        ? t("common.loading")
                        : t("register.submit")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 w-full"
                      onClick={() => {
                        setStep("code");
                        setPassword("");
                        setConfirmation("");
                        clearFeedback();
                      }}
                    >
                      {t("register.back_to_code")}
                    </Button>
                  </form>
                )}
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
