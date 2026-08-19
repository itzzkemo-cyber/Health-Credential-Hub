import { useState } from "react";
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

function apiErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError
    ? (err.data as { code?: string } | null)?.code
    : undefined;
}

/** Shown once after activation/regeneration — the only time codes are visible. */
function BackupCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useLanguage();
  const copyAll = async () => {
    await navigator.clipboard.writeText(codes.join("\n"));
    toast.success(t("twofa.codes_copied"));
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
        <Button type="button" variant="outline" size="sm" onClick={copyAll} className="gap-2">
          <Copy className="h-4 w-4" /> {t("twofa.codes_copy")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download} className="gap-2">
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
  const [enrolling, setEnrolling] = useState<TotpSetupData | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const setupMutation = useTotpSetup();
  const verifyMutation = useTotpVerifySetup();

  // --- Disable / regenerate flows ---
  const [confirmMode, setConfirmMode] = useState<"disable" | "regen" | null>(null);
  const [password, setPassword] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const disableMutation = useTotpDisable();
  const regenMutation = useTotpRegenerateBackup();

  const refreshMe = () => queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });

  const startEnable = () => {
    setSetupCode("");
    setupMutation.mutate(undefined, {
      onSuccess: (data) => setEnrolling(data),
      onError: () => toast.error(t("twofa.setup_expired")),
    });
  };

  const submitVerify = (code: string) => {
    if (!enrolling || code.length < 6 || verifyMutation.isPending) return;
    verifyMutation.mutate(
      { data: { setupToken: enrolling.setupToken, code } },
      {
        onSuccess: (res) => {
          setEnrolling(null);
          setFreshCodes(res.backupCodes);
          refreshMe();
          toast.success(t("twofa.enabled_success"));
        },
        onError: (err) => {
          const code = apiErrorCode(err);
          if (code === "invalid_code") {
            toast.error(t("twofa.invalid_code"));
            setSetupCode("");
          } else {
            toast.error(t("twofa.setup_expired"));
            setEnrolling(null);
          }
        },
      },
    );
  };

  const closeConfirm = () => {
    setConfirmMode(null);
    setPassword("");
    setConfirmCode("");
  };

  const submitConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || !confirmCode) return;
    const onError = (err: unknown) => {
      const code = apiErrorCode(err);
      if (code === "wrong_password") toast.error(t("twofa.wrong_password"));
      else toast.error(t("twofa.invalid_code"));
    };
    if (confirmMode === "disable") {
      disableMutation.mutate(
        { data: { currentPassword: password, code: confirmCode } },
        {
          onSuccess: () => {
            closeConfirm();
            refreshMe();
            toast.success(t("twofa.disabled_success"));
          },
          onError,
        },
      );
    } else {
      regenMutation.mutate(
        { data: { currentPassword: password, code: confirmCode } },
        {
          onSuccess: (res) => {
            closeConfirm();
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
                  onClick={() => setConfirmMode("regen")}
                >
                  <KeyRound className="h-4 w-4" /> {t("twofa.regenerate")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmMode("disable")}
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

      {/* Enrollment: QR + first OTP */}
      <Dialog open={!!enrolling} onOpenChange={(open) => !open && setEnrolling(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("twofa.setup_title")}</DialogTitle>
            <DialogDescription>{t("twofa.setup_scan")}</DialogDescription>
          </DialogHeader>
          {enrolling && (
            <div className="space-y-5">
              <div className="flex justify-center">
                <img
                  src={enrolling.qrDataUrl}
                  alt="TOTP QR"
                  className="h-56 w-56 rounded-lg border bg-white p-2"
                />
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t("twofa.setup_manual")}</p>
                <button
                  type="button"
                  dir="ltr"
                  className="w-full rounded-md border bg-muted/40 px-3 py-2 text-center font-mono text-xs tracking-widest break-all hover:bg-muted"
                  onClick={async () => {
                    await navigator.clipboard.writeText(enrolling.secret);
                    toast.success(t("twofa.codes_copied"));
                  }}
                >
                  {enrolling.secret}
                </button>
              </div>
              <div className="space-y-2">
                <Label>{t("twofa.setup_code_label")}</Label>
                <div className="flex justify-center" dir="ltr">
                  <InputOTP
                    maxLength={6}
                    value={setupCode}
                    onChange={setSetupCode}
                    onComplete={(v: string) => submitVerify(v)}
                  >
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4, 5].map((i) => (
                        <InputOTPSlot key={i} index={i} className="h-11 w-11" />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              </div>
              <Button
                className="w-full"
                disabled={setupCode.length < 6 || verifyMutation.isPending}
                onClick={() => submitVerify(setupCode)}
              >
                {verifyMutation.isPending ? t("common.loading") : t("twofa.activate")}
              </Button>
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
      <Dialog open={!!confirmMode} onOpenChange={(open) => !open && closeConfirm()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmMode === "disable" ? t("twofa.disable_title") : t("twofa.regen_title")}
            </DialogTitle>
            <DialogDescription>
              {confirmMode === "disable" ? t("twofa.disable_hint") : t("twofa.regen_hint")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitConfirm} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="twofa-password">{t("twofa.current_password")}</Label>
              <Input
                id="twofa-password"
                type="password"
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="twofa-code">{t("twofa.code_label")}</Label>
              <Input
                id="twofa-code"
                dir="ltr"
                className="font-mono"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                placeholder="123456 / XXXXX-XXXXX"
              />
            </div>
            <DialogFooter>
              <Button
                type="submit"
                variant={confirmMode === "disable" ? "destructive" : "default"}
                className="w-full"
                disabled={!password || !confirmCode || confirmPending}
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
