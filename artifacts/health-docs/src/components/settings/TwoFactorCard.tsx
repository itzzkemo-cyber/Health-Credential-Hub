import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  getGetMeQueryKey,
  useTotpSetup,
  useTotpVerifySetup,
  useTotpDisable,
  useTotpRegenerateBackup,
  ApiError,
  type TotpSetupData,
} from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { ShieldCheck, Copy, Download, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { QueryErrorState } from "@/components/QueryErrorState";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  ADMIN_MFA_CODE_FIELD,
  ADMIN_MFA_CURRENT_PASSWORD_FIELD,
  readAdminMfaStepUpCredentials,
  readCurrentPassword,
  readVerificationCode,
} from "@/pages/employees/admin-mfa-step-up";

function apiErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError
    ? (err.data as { code?: string } | null)?.code
    : undefined;
}

/** Shown once after activation/regeneration — the only time codes are visible. */
function BackupCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useLanguage();
  const copyAll = async () => {
    const copied = await copyTextToClipboard(codes.join("\n"));
    if (copied) toast.success(t("twofa.codes_copied"));
    else toast.error(t("twofa.copy_failed"));
  };
  const download = () => {
    const blob = new Blob(
      [`${t("auth.brand_name")} — Backup codes (${new Date().toISOString().slice(0, 10)})\n\n${codes.join("\n")}\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wathaiqi-health-backup-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("twofa.codes_hint")}</p>
      <div className="grid grid-cols-2 gap-2" dir="ltr">
        {codes.map((c) => (
          <div
            key={c}
            className="rounded-md border bg-muted/40 px-3 py-2 text-center font-mono text-sm tracking-wider"
          >
            {c}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copyAll}
          className="min-h-11 gap-2"
        >
          <Copy className="h-4 w-4" /> {t("twofa.codes_copy")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={download}
          className="min-h-11 gap-2"
        >
          <Download className="h-4 w-4" /> {t("twofa.codes_download")}
        </Button>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone} className="w-full">
          {t("twofa.codes_saved")}
        </Button>
      </DialogFooter>
    </div>
  );
}

export default function TwoFactorCard() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { data: me, error, isError, isLoading, refetch } = useGetMe();

  // --- Enable flow ---
  const [isSetupAuthOpen, setIsSetupAuthOpen] = useState(false);
  const [enrolling, setEnrolling] = useState<TotpSetupData | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const setupAuthFormRef = useRef<HTMLFormElement>(null);
  const setupAuthPasswordRef = useRef<HTMLInputElement>(null);
  const enrollmentFormRef = useRef<HTMLFormElement>(null);
  const enrollmentCodeRef = useRef<HTMLInputElement>(null);
  const setupMutation = useTotpSetup({ mutation: { gcTime: 0 } });
  const verifyMutation = useTotpVerifySetup({ mutation: { gcTime: 0 } });

  // --- Disable / regenerate flows ---
  const [confirmMode, setConfirmMode] = useState<"disable" | "regen" | null>(null);
  const confirmFormRef = useRef<HTMLFormElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const disableMutation = useTotpDisable({ mutation: { gcTime: 0 } });
  const regenMutation = useTotpRegenerateBackup({ mutation: { gcTime: 0 } });

  const refreshMe = () => queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });

  const startEnable = () => {
    setupAuthFormRef.current?.reset();
    setupMutation.reset();
    setIsSetupAuthOpen(true);
  };

  const closeSetupAuthorization = () => {
    if (setupMutation.isPending) return;
    setupAuthFormRef.current?.reset();
    setupMutation.reset();
    setIsSetupAuthOpen(false);
  };

  const submitSetupAuthorization = (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (setupMutation.isPending) return;

    const form = event.currentTarget;
    const currentPassword = readCurrentPassword(new FormData(form));
    if (!currentPassword) return;

    setupMutation.mutate(
      { data: { currentPassword } },
      {
        onSuccess: (data) => {
          form.reset();
          setupMutation.reset();
          setIsSetupAuthOpen(false);
          setEnrolling(data);
        },
        onError: (error) => {
          const code = apiErrorCode(error);
          form.reset();
          setupMutation.reset();
          requestAnimationFrame(() => setupAuthPasswordRef.current?.focus());
          toast.error(
            t(
              code === "step_up_failed"
                ? "twofa.wrong_password"
                : "twofa.setup_expired",
            ),
          );
        },
      },
    );
  };

  const closeEnrollment = () => {
    if (verifyMutation.isPending) return;
    enrollmentFormRef.current?.reset();
    verifyMutation.reset();
    setEnrolling(null);
  };

  const submitVerify = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enrolling || verifyMutation.isPending) return;

    const form = event.currentTarget;
    const code = readVerificationCode(new FormData(form));
    if (!code || code.length < 6) return;

    verifyMutation.mutate(
      { data: { setupToken: enrolling.setupToken, code } },
      {
        onSuccess: (res) => {
          form.reset();
          verifyMutation.reset();
          setEnrolling(null);
          setFreshCodes(res.backupCodes);
          refreshMe();
          toast.success(t("twofa.enabled_success"));
        },
        onError: (err) => {
          const code = apiErrorCode(err);
          form.reset();
          verifyMutation.reset();
          if (code === "invalid_code") {
            toast.error(t("twofa.invalid_code"));
            requestAnimationFrame(() => enrollmentCodeRef.current?.focus());
          } else {
            toast.error(t("twofa.setup_expired"));
            setEnrolling(null);
          }
        },
      },
    );
  };

  const openConfirm = (mode: "disable" | "regen") => {
    confirmFormRef.current?.reset();
    disableMutation.reset();
    regenMutation.reset();
    setConfirmMode(mode);
  };

  const closeConfirm = () => {
    if (disableMutation.isPending || regenMutation.isPending) return;
    confirmFormRef.current?.reset();
    disableMutation.reset();
    regenMutation.reset();
    setConfirmMode(null);
  };

  const submitConfirm = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmMode || disableMutation.isPending || regenMutation.isPending) {
      return;
    }

    const form = event.currentTarget;
    const credentials = readAdminMfaStepUpCredentials(new FormData(form));
    if (!credentials) return;

    const onError = (err: unknown) => {
      const code = apiErrorCode(err);
      form.reset();
      disableMutation.reset();
      regenMutation.reset();
      requestAnimationFrame(() => confirmPasswordRef.current?.focus());
      if (code === "wrong_password") toast.error(t("twofa.wrong_password"));
      else toast.error(t("twofa.invalid_code"));
    };
    if (confirmMode === "disable") {
      disableMutation.mutate(
        { data: credentials },
        {
          onSuccess: () => {
            form.reset();
            disableMutation.reset();
            setConfirmMode(null);
            refreshMe();
            toast.success(t("twofa.disabled_success"));
          },
          onError,
        },
      );
    } else {
      regenMutation.mutate(
        { data: credentials },
        {
          onSuccess: (res) => {
            form.reset();
            regenMutation.reset();
            setConfirmMode(null);
            setFreshCodes(res.backupCodes);
            toast.success(t("twofa.regen_success"));
          },
          onError,
        },
      );
    }
  };

  const confirmPending = disableMutation.isPending || regenMutation.isPending;

  return (
    <Card className="hover-elevate">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <CardTitle>{t("twofa.title")}</CardTitle>
        </div>
        <CardDescription>{t("twofa.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : isError || !me ? (
          <QueryErrorState
            error={error}
            onRetry={() => void refetch()}
            compact
          />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Badge
              variant={me.totpEnabled ? "default" : "secondary"}
              className={me.totpEnabled ? "bg-emerald-600 hover:bg-emerald-600" : ""}
            >
              {me.totpEnabled ? t("twofa.status_on") : t("twofa.status_off")}
            </Badge>
            {me.totpEnabled ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => openConfirm("regen")}
                >
                  <KeyRound className="h-4 w-4" /> {t("twofa.regenerate")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => openConfirm("disable")}
                >
                  {t("twofa.disable")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                onClick={startEnable}
                disabled={setupMutation.isPending}
              >
                {setupMutation.isPending ? t("common.loading") : t("twofa.enable")}
              </Button>
            )}
          </div>
        )}
      </CardContent>

      {/* Confirm the current password before issuing a new MFA secret. */}
      <Dialog
        open={isSetupAuthOpen}
        onOpenChange={(open) => {
          if (open) setIsSetupAuthOpen(true);
          else closeSetupAuthorization();
        }}
      >
        <DialogContent
          className="max-h-[90dvh] max-w-md overflow-y-auto"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            setupAuthPasswordRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("twofa.setup_password_title")}</DialogTitle>
            <DialogDescription>
              {t("twofa.setup_password_hint")}
            </DialogDescription>
          </DialogHeader>
          <form
            ref={setupAuthFormRef}
            onSubmit={submitSetupAuthorization}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="twofa-setup-password">
                {t("twofa.current_password")}
              </Label>
              <Input
                ref={setupAuthPasswordRef}
                id="twofa-setup-password"
                name={ADMIN_MFA_CURRENT_PASSWORD_FIELD}
                type="password"
                dir="ltr"
                autoComplete="current-password"
                required
                className="min-h-11"
              />
            </div>
            <DialogFooter className="gap-2 sm:space-x-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                disabled={setupMutation.isPending}
                onClick={closeSetupAuthorization}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                className="min-h-11 w-full sm:w-auto"
                disabled={setupMutation.isPending}
              >
                {setupMutation.isPending
                  ? t("common.loading")
                  : t("twofa.setup_continue")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Enrollment: QR + first OTP */}
      <Dialog
        open={!!enrolling}
        onOpenChange={(open) => !open && closeEnrollment()}
      >
        <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("twofa.setup_title")}</DialogTitle>
            <DialogDescription>{t("twofa.setup_scan")}</DialogDescription>
          </DialogHeader>
          {enrolling && (
            <div className="space-y-5">
              <div className="flex justify-center">
                <img
                  src={enrolling.qrDataUrl}
                  alt={t("twofa.setup_qr_alt")}
                  className="h-auto w-full max-w-56 rounded-lg border bg-white p-2"
                />
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t("twofa.setup_manual")}</p>
                <div className="flex items-stretch gap-2">
                  <code
                    dir="ltr"
                    className="flex min-h-11 min-w-0 flex-1 select-all items-center justify-center rounded-md border bg-muted/40 px-3 py-2 text-center text-xs tracking-widest break-all"
                  >
                    {enrolling.secret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("twofa.secret_copy")}
                    title={t("twofa.secret_copy")}
                    className="size-11 shrink-0 touch-manipulation"
                    onClick={async () => {
                      const copied = await copyTextToClipboard(
                        enrolling.secret,
                      );
                      if (copied) {
                        toast.success(t("twofa.secret_copied"));
                      } else {
                        toast.error(t("twofa.copy_failed"));
                      }
                    }}
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <form
                ref={enrollmentFormRef}
                onSubmit={submitVerify}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="twofa-setup-code">
                    {t("twofa.setup_code_label")}
                  </Label>
                  <div className="flex justify-center" dir="ltr">
                    <InputOTP
                      ref={enrollmentCodeRef}
                      id="twofa-setup-code"
                      name={ADMIN_MFA_CODE_FIELD}
                      maxLength={6}
                      minLength={6}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      required
                    >
                      <InputOTPGroup>
                        {[0, 1, 2, 3, 4, 5].map((i) => (
                          <InputOTPSlot
                            key={i}
                            index={i}
                            className="h-11 w-10 sm:w-11"
                          />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                </div>
                <Button
                  type="submit"
                  className="min-h-11 w-full"
                  disabled={verifyMutation.isPending}
                >
                  {verifyMutation.isPending
                    ? t("common.loading")
                    : t("twofa.activate")}
                </Button>
              </form>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* One-time backup codes display (after enable or regenerate) */}
      <Dialog open={!!freshCodes} onOpenChange={(open) => !open && setFreshCodes(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("twofa.codes_title")}</DialogTitle>
          </DialogHeader>
          {freshCodes && (
            <BackupCodesView codes={freshCodes} onDone={() => setFreshCodes(null)} />
          )}
        </DialogContent>
      </Dialog>

      {/* Disable / regenerate confirmation (password + second factor) */}
      <Dialog
        open={!!confirmMode}
        onOpenChange={(open) => !open && closeConfirm()}
      >
        <DialogContent
          className="max-h-[90dvh] max-w-md overflow-y-auto"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            confirmPasswordRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {confirmMode === "disable" ? t("twofa.disable_title") : t("twofa.regen_title")}
            </DialogTitle>
            <DialogDescription>
              {confirmMode === "disable" ? t("twofa.disable_hint") : t("twofa.regen_hint")}
            </DialogDescription>
          </DialogHeader>
          <form
            ref={confirmFormRef}
            onSubmit={submitConfirm}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="twofa-password">{t("twofa.current_password")}</Label>
              <Input
                ref={confirmPasswordRef}
                id="twofa-password"
                name={ADMIN_MFA_CURRENT_PASSWORD_FIELD}
                type="password"
                dir="ltr"
                autoComplete="current-password"
                required
                className="min-h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="twofa-code">{t("twofa.code_label")}</Label>
              <Input
                id="twofa-code"
                name={ADMIN_MFA_CODE_FIELD}
                type="text"
                dir="ltr"
                inputMode="text"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="min-h-11 font-mono"
                placeholder="123456 / XXXXX-XXXXX"
                required
              />
            </div>
            <DialogFooter className="gap-2 sm:space-x-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                disabled={confirmPending}
                onClick={closeConfirm}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant={confirmMode === "disable" ? "destructive" : "default"}
                className="min-h-11 w-full sm:w-auto"
                disabled={confirmPending}
              >
                {confirmPending
                  ? t("common.loading")
                  : confirmMode === "disable"
                    ? t("twofa.disable")
                    : t("twofa.regenerate")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
