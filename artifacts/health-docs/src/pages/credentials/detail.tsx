import { useRoute, useLocation } from "wouter";
import { useGetCredential, useDeleteCredential, getListCredentialsQueryKey } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { QRCodeSVG } from "qrcode.react";
import { ArrowRight, ArrowLeft, Printer, Copy, Trash2, Edit, FileText, CheckCircle2, AlertTriangle, ShieldAlert, ExternalLink } from "lucide-react";
import { isPdfUrl, resolveStoredFileUrl, openFileInNewTab } from "@/lib/file-preview";
import { toast } from "sonner";
import { formatDistanceToNow, isPast } from "date-fns";
import { arSA } from "date-fns/locale";

export default function CredentialDetail() {
  const { t, isRTL, language } = useLanguage();
  const [, params] = useRoute("/credentials/:id");
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const id = Number(params?.id);

  const { data: cred, isLoading, isError } = useGetCredential(id);

  const deleteCred = useDeleteCredential();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !cred) {
    return <div className="text-center p-8 text-destructive">Error loading credential</div>;
  }

  // Storage paths resolve to the authenticated API serving route.
  const fileSrc = cred.fileUrl ? resolveStoredFileUrl(cred.fileUrl) : null;

  const handleDelete = () => {
    if (confirm(t('common.confirm') + " " + t('common.delete') + "?")) {
      deleteCred.mutate({ id }, {
        onSuccess: () => {
          toast.success("Credential deleted");
          queryClient.invalidateQueries({ queryKey: getListCredentialsQueryKey() });
          setLocation('/credentials');
        }
      });
    }
  };

  const verifyUrl = new URL(
    `${import.meta.env.BASE_URL}verify/${cred.qrToken}`,
    window.location.origin,
  ).toString();

  const copyLink = () => {
    navigator.clipboard.writeText(verifyUrl);
    toast.success("Verification link copied to clipboard");
  };

  const getStatusIcon = (status: string) => {
    switch(status) {
      case 'active': return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
      case 'expiring_soon': return <AlertTriangle className="h-5 w-5 text-amber-500" />;
      case 'expired': return <ShieldAlert className="h-5 w-5 text-destructive" />;
      default: return <FileText className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'active': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400';
      case 'expiring_soon': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
      case 'expired': return 'bg-destructive/10 text-destructive dark:bg-destructive/20';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const expiryDate = new Date(cred.expiryDate);
  const timeText = formatDistanceToNow(expiryDate, { 
    addSuffix: true, 
    locale: language === 'ar' ? arSA : undefined 
  });

  return (
    <div className="max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500 pb-12">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation('/credentials')}>
            {isRTL ? <ArrowRight className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
          </Button>
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 p-2 rounded-lg">
              {getStatusIcon(cred.status)}
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {isRTL ? (cred.customTypeNameAr || cred.type) : (cred.customTypeName || cred.type)}
              </h1>
              <p className="text-muted-foreground text-sm">{t('credential.certificate_number')}: {cred.certificateNumber}</p>
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2">
            <Edit className="h-4 w-4" /> <span className="hidden sm:inline">{t('common.edit')}</span>
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDelete} className="gap-2" disabled={deleteCred.isPending}>
            <Trash2 className="h-4 w-4" /> <span className="hidden sm:inline">{t('common.delete')}</span>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        <div className="lg:col-span-2 space-y-6">
          <Card className="hover-elevate">
            <CardHeader>
              <CardTitle className="text-lg">Credential Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <p className="text-sm text-muted-foreground">{t('credential.holder_name')}</p>
                  <p className="font-medium text-lg">{isRTL ? cred.holderNameAr : cred.holderName}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('credential.issuer')}</p>
                  <p className="font-medium text-lg">{isRTL ? cred.issuerNameAr : cred.issuerName}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('credential.issue_date')}</p>
                  <p className="font-medium">{new Date(cred.issueDate).toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('credential.expiry_date')}</p>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{expiryDate.toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}</p>
                    <Badge variant="outline" className={cn("text-xs font-normal border-0", getStatusColor(cred.status))}>
                      {timeText}
                    </Badge>
                  </div>
                </div>
              </div>

              {cred.notes && (
                <div className="pt-4 border-t border-border">
                  <p className="text-sm text-muted-foreground">{t('credential.notes')}</p>
                  <p className="mt-1 text-sm">{cred.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="hover-elevate overflow-hidden">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-lg">{t('credential.document_preview')}</CardTitle>
              {cred.fileUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => openFileInNewTab(cred.fileUrl!)}
                >
                  <ExternalLink className="h-4 w-4" /> {t('credential.open_file')}
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0 bg-muted/30">
              {cred.fileUrl ? (
                (cred.fileType === "pdf" || isPdfUrl(cred.fileUrl)) ? (
                  // <object> uses the browser's native PDF viewer where
                  // available (desktop) and renders the children as a
                  // fallback on browsers without inline PDF support
                  // (e.g. Android Chrome).
                  <object
                    data={fileSrc!}
                    type="application/pdf"
                    className="w-full h-[520px] bg-white"
                  >
                    <div className="w-full h-full flex flex-col items-center justify-center gap-4 text-muted-foreground p-8 text-center">
                      <FileText className="h-16 w-16 opacity-50" />
                      <p className="text-sm">{t('credential.pdf_open_hint')}</p>
                      <Button className="gap-2" onClick={() => openFileInNewTab(cred.fileUrl!)}>
                        <ExternalLink className="h-4 w-4" /> {t('credential.open_file')}
                      </Button>
                    </div>
                  </object>
                ) : (
                  <div className="w-full aspect-[4/3] bg-muted/50 flex items-center justify-center overflow-hidden">
                    <img src={fileSrc!} alt={t('credential.document_preview')} className="w-full h-full object-contain" />
                  </div>
                )
              ) : (
                <div className="w-full aspect-[21/9] flex items-center justify-center text-muted-foreground border-t border-border border-dashed">
                  {t('credential.no_document')}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="hover-elevate">
            <CardHeader className="bg-primary/5 pb-4 border-b border-primary/10">
              <CardTitle className="text-lg flex justify-between items-center">
                Verification QR
                <Badge className={getStatusColor(cred.status)} variant="outline">
                  {t(`common.${cred.status}`)}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center p-8">
              <div className="bg-white p-4 rounded-xl shadow-sm border border-border mb-6">
                <QRCodeSVG 
                  value={verifyUrl} 
                  size={160}
                  bgColor="#ffffff"
                  fgColor="#0f172a"
                  level="Q"
                />
              </div>
              <div className="w-full space-y-3">
                <Button variant="outline" className="w-full gap-2" onClick={copyLink}>
                  <Copy className="h-4 w-4" /> Copy Link
                </Button>
                <Button variant="outline" className="w-full gap-2" onClick={() => window.print()}>
                  <Printer className="h-4 w-4" /> Print QR Badge
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="hover-elevate">
            <CardHeader>
              <CardTitle className="text-lg">Status Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex gap-4 relative">
                  <div className="absolute top-8 left-2.5 bottom-[-16px] w-px bg-border rtl:right-2.5" />
                  <div className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center shrink-0 mt-1 z-10">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Issued</p>
                    <p className="text-xs text-muted-foreground">{new Date(cred.issueDate).toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}</p>
                  </div>
                </div>
                
                <div className="flex gap-4 relative">
                   <div className="absolute top-8 left-2.5 bottom-[-16px] w-px bg-border rtl:right-2.5" />
                  <div className="w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center shrink-0 mt-1 z-10">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">System Entry</p>
                    <p className="text-xs text-muted-foreground">{new Date(cred.createdAt).toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}</p>
                  </div>
                </div>

                <div className="flex gap-4 relative">
                  <div className={cn(
                    "w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-1 z-10",
                    isPast(expiryDate) ? "bg-destructive/20" : "bg-muted"
                  )}>
                    <div className={cn(
                      "w-2 h-2 rounded-full",
                      isPast(expiryDate) ? "bg-destructive" : "bg-muted-foreground"
                    )} />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Expiry</p>
                    <p className="text-xs text-muted-foreground">{expiryDate.toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

      </div>
    </div>
  );
}

function cn(...classes: (string | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
