import { useRoute } from "wouter";
import { useVerifyCredential } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { Card, CardContent } from "@/components/ui/card";
import { ShieldCheck, ShieldAlert, FileText, CheckCircle2, Building2, Calendar, Clock3 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

type Translator = (key: string) => string;

type VerifiedCredentialData = {
  verificationState: "verified";
  type: string;
  issuerName: string;
  issueDate: string;
  expiryDate: string;
  status: string;
  verificationCode: string;
};

export function hasVerifiedCredentialData(
  value: unknown,
): value is VerifiedCredentialData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.verificationState === "verified" &&
    typeof candidate.type === "string" &&
    typeof candidate.issuerName === "string" &&
    typeof candidate.issueDate === "string" &&
    typeof candidate.expiryDate === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.verificationCode === "string"
  );
}

export function VerificationFooter({ t }: { t: Translator }) {
  return (
    <footer className="mt-8 space-y-1 text-center text-xs text-muted-foreground">
      <p>{t("verify_page.powered_by")} &copy; {new Date().getFullYear()}</p>
      <p>
        {t("verify_page.developed_by")}{" "}
        <bdi lang="en" dir="ltr" className="font-semibold text-foreground/80">
          ABDULKARIM ALHEJAILI
        </bdi>
      </p>
    </footer>
  );
}

export default function VerifyQR() {
  const [, params] = useRoute("/verify/:token");
  const { t, isRTL } = useLanguage();
  const token = params?.token;

  // The verify endpoint takes the QR token string directly (public, no auth).
  const { data: verData, isLoading, isError } = useVerifyCredential(token ?? "");

  const isPendingVerification = verData?.verificationState === "pending";
  const isVerified = hasVerifiedCredentialData(verData);
  const isExpired = isVerified && verData.status === "expired";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 py-12 px-4 flex flex-col items-center">
      
      {/* Government-like header */}
      <div className="w-full max-w-md flex flex-col items-center mb-8">
        <div className="h-16 w-16 bg-primary rounded-2xl flex items-center justify-center mb-4 shadow-lg">
          <ShieldCheck className="h-8 w-8 text-primary-foreground" />
        </div>
        <h1 className="text-2xl font-bold text-center">{t('verify_page.title')}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t('verify_page.registry')}</p>
      </div>

      <div className="w-full max-w-md">
        {isLoading ? (
          <Card className="border-t-4 border-t-muted">
            <CardContent className="p-8 space-y-6 text-center">
              <Skeleton className="h-16 w-16 rounded-full mx-auto" />
              <div className="space-y-2">
                <Skeleton className="h-6 w-3/4 mx-auto" />
                <Skeleton className="h-4 w-1/2 mx-auto" />
              </div>
            </CardContent>
          </Card>
        ) : isError || !verData ? (
          <Card className="border-t-4 border-t-destructive shadow-xl">
            <CardContent className="p-8 text-center space-y-4">
              <div className="mx-auto w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center">
                <ShieldAlert className="h-8 w-8 text-destructive" />
              </div>
              <h2 className="text-xl font-bold text-destructive">{t('verify_page.invalid_title')}</h2>
              <p className="text-muted-foreground text-sm">
                {t('verify_page.invalid_description')}
              </p>
            </CardContent>
          </Card>
        ) : isPendingVerification ? (
          <Card className="border-t-4 border-t-amber-500 shadow-xl">
            <CardContent className="space-y-4 p-8 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 ring-4 ring-amber-50 dark:bg-amber-900 dark:ring-amber-950">
                <Clock3 className="h-8 w-8 text-amber-600 dark:text-amber-400" />
              </div>
              <h2 className="text-xl font-bold text-amber-700 dark:text-amber-400">
                {t("verify_page.pending_title")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("verify_page.pending_description")}
              </p>
            </CardContent>
          </Card>
        ) : isVerified ? (
          <Card className={`border-t-4 ${isExpired ? "border-t-amber-500" : "border-t-emerald-500"} shadow-xl overflow-hidden animate-in zoom-in-95 duration-500`}>
            <div className={`${isExpired ? "bg-amber-50 dark:bg-amber-950/30" : "bg-emerald-50 dark:bg-emerald-950/30"} p-6 text-center border-b border-border`}>
              <div className={`mx-auto w-16 h-16 ${isExpired ? "bg-amber-100 dark:bg-amber-900 ring-amber-50 dark:ring-amber-950" : "bg-emerald-100 dark:bg-emerald-900 ring-emerald-50 dark:ring-emerald-950"} rounded-full flex items-center justify-center mb-4 ring-4`}>
                {isExpired ? (
                  <ShieldAlert className="h-8 w-8 text-amber-600 dark:text-amber-400" />
                ) : (
                  <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                )}
              </div>
              <h2 className={`text-xl font-bold ${isExpired ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                {isExpired ? t('verify_page.authentic_expired') : t('verify_page.verified_active')}
              </h2>
              <p className={`text-sm ${isExpired ? "text-amber-600/80 dark:text-amber-400/80" : "text-emerald-600/80 dark:text-emerald-400/80"} mt-1 font-mono`}>
                {t('verify_page.auth_code')}: {verData.verificationCode}
              </p>
            </div>

            <CardContent className="p-6 space-y-6">
              <div>
                <p className="text-sm text-muted-foreground mb-1 flex items-center gap-2">
                  <FileText className="h-4 w-4" /> {t('verify_page.credential_type')}
                </p>
                <p className="font-semibold text-lg">{verData.type}</p>
              </div>

              <div className="h-px w-full bg-border" />

              <div>
                <p className="text-sm text-muted-foreground mb-1 flex items-center gap-2">
                  <Building2 className="h-4 w-4" /> {t('verify_page.issuing_authority')}
                </p>
                <p className="font-medium">{verData.issuerName}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-1 flex items-center gap-2">
                    <Calendar className="h-4 w-4" /> {t('verify_page.issue_date')}
                  </p>
                  <p className="font-medium">
                    {new Date(verData.issueDate).toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1 flex items-center gap-2">
                    <Calendar className="h-4 w-4" /> {t('verify_page.expiry_date')}
                  </p>
                  <p className="font-medium">
                    {new Date(verData.expiryDate).toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}
                  </p>
                </div>
              </div>
            </CardContent>
            
            <div className="bg-muted/30 p-4 text-center text-xs text-muted-foreground border-t border-border">
              {t('verify_page.verified_on')} {new Date().toLocaleString(isRTL ? 'ar-SA' : 'en-US')}
            </div>
          </Card>
        ) : null}
      </div>
      
      <VerificationFooter t={t} />
    </div>
  );
}
