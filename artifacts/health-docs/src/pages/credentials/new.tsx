import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileCheck2,
  FileText,
  Info,
  Loader2,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import {
  CredentialInputType,
  getGetEmployeeQueryKey,
  useCreateCredential,
  useExtractCredentialOcr,
  useGetEmployee,
  useRequestUploadUrl,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import { prepareUploadFile, UploadTooLargeError } from "@/lib/upload";
import { cn } from "@/lib/utils";

const FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,application/pdf";

export default function CredentialNew() {
  const { t, isRTL } = useLanguage();
  const [, setLocation] = useLocation();
  const user = getAuthUser();
  const requestedEmployeeId = Number(
    new URLSearchParams(window.location.search).get("employeeId"),
  );
  const mayUploadForOthers = user?.role !== "employee";
  const employeeId =
    mayUploadForOthers &&
    Number.isInteger(requestedEmployeeId) &&
    requestedEmployeeId > 0
      ? requestedEmployeeId
      : user?.id;
  const { data: targetEmployee } = useGetEmployee(employeeId ?? 0, {
    query: {
      queryKey: getGetEmployeeQueryKey(employeeId ?? 0),
      enabled: Boolean(employeeId && employeeId !== user?.id),
    },
  });

  const [activeTab, setActiveTab] = useState("smart");
  const [fileUrl, setFileUrl] = useState("");
  const [fileKind, setFileKind] = useState<"pdf" | "image" | "">("");
  const [fileName, setFileName] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const extractOcr = useExtractCredentialOcr();
  const createCredential = useCreateCredential();
  const requestUploadUrl = useRequestUploadUrl();

  const [formData, setFormData] = useState({
    type: "BLS" as CredentialInputType,
    holderName: user?.name || "",
    holderNameAr: user?.nameAr || "",
    issuerName: "",
    issuerNameAr: "",
    certificateNumber: "",
    issueDate: "",
    expiryDate: "",
    notes: "",
  });

  useEffect(() => {
    if (!targetEmployee) return;
    setFormData((previous) => ({
      ...previous,
      holderName: targetEmployee.name,
      holderNameAr: targetEmployee.nameAr,
    }));
  }, [targetEmployee]);

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
    useSmartScan: boolean,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setIsUploading(true);
    try {
      const prepared = await prepareUploadFile(file);
      const granted = await requestUploadUrl.mutateAsync({
        data: {
          name: file.name,
          size: prepared.blob.size,
          contentType: prepared.contentType,
        },
      });
      const upload = await fetch(granted.uploadURL, {
        method: "PUT",
        body: prepared.blob,
        headers: { "Content-Type": prepared.contentType },
      });
      if (!upload.ok) throw new Error(`Storage upload failed (${upload.status})`);

      setFileUrl(granted.objectPath);
      setFileKind(prepared.kind);
      setFileName(file.name);

      if (!useSmartScan) {
        toast.success(t("credential.upload_success"));
        return;
      }

      extractOcr.mutate(
        { data: { fileUrl: granted.objectPath, fileName: file.name } },
        {
          onSuccess: (result) => {
            toast.success(t("credential.scan_success"));
            setFormData((previous) => ({
              ...previous,
              type: (result.detectedType as CredentialInputType) || "BLS",
              holderName: result.holderName || previous.holderName,
              holderNameAr: result.holderNameAr || previous.holderNameAr,
              issuerName: result.issuerName || "",
              issuerNameAr: result.issuerNameAr || "",
              certificateNumber: result.certificateNumber || "",
              issueDate: result.issueDate ? result.issueDate.split("T")[0] : "",
              expiryDate: result.expiryDate ? result.expiryDate.split("T")[0] : "",
            }));
            setActiveTab("manual");
          },
          onError: () => {
            toast.error(t("credential.scan_failed"));
            setActiveTab("manual");
          },
        },
      );
    } catch (error) {
      toast.error(
        t(
          error instanceof UploadTooLargeError
            ? "credential.file_too_large"
            : "credential.upload_failed",
        ),
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!employeeId) {
      toast.error(t("credential.employee_required"));
      return;
    }
    if (formData.issueDate > formData.expiryDate) {
      toast.error(t("credential.date_order_error"));
      return;
    }

    createCredential.mutate(
      {
        data: {
          ...formData,
          employeeId,
          fileUrl: fileUrl || undefined,
          fileType: fileUrl ? fileKind || "image" : undefined,
        },
      },
      {
        onSuccess: (result) => {
          toast.success(t("credential.create_success"));
          setLocation(`/credentials/${result.id}`);
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : t("credential.create_failed"));
        },
      },
    );
  };

  const isFileBusy = isUploading || extractOcr.isPending;
  const types = Object.keys(CredentialInputType);

  return (
    <div className="mx-auto max-w-3xl space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 md:space-y-8">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation("/credentials")}
          aria-label={t("common.back")}
          className="shrink-0"
        >
          {isRTL ? <ArrowRight className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
        </Button>
        <div>
          <p className="text-sm font-medium text-primary">{t("employee_portal.dashboard_eyebrow")}</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            {t("credential.add_new")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            {t("credential.add_subtitle")}
          </p>
        </div>
      </div>

      {targetEmployee && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          {t("credential.uploading_for")}:{" "}
          <strong>{isRTL ? targetEmployee.nameAr : targetEmployee.name}</strong>
        </div>
      )}

      <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <p className="leading-6">{t("credential.private_upload_notice")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="mb-5 grid h-auto w-full grid-cols-2 p-1 sm:mb-8">
          <TabsTrigger value="smart" className="min-h-11 gap-2 px-2">
            <UploadCloud className="h-4 w-4" aria-hidden="true" />
            <span className="truncate">{t("credential.smart_scan")}</span>
          </TabsTrigger>
          <TabsTrigger value="manual" className="min-h-11 gap-2 px-2">
            <FileText className="h-4 w-4" aria-hidden="true" />
            <span className="truncate">{t("credential.manual")}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="smart" className="space-y-4">
          <div className="flex items-start gap-3 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
            <Info className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="leading-6">{t("credential.ocr_review_notice")}</p>
          </div>
          <DocumentPicker
            id="smart-document-upload"
            busy={isFileBusy}
            fileName={fileName}
            onChange={(event) => void handleFileUpload(event, true)}
            t={t}
          />
        </TabsContent>

        <TabsContent value="manual">
          <Card>
            <CardContent className="p-4 sm:p-6">
              <form onSubmit={handleSubmit} className="space-y-6">
                <section className="space-y-3" aria-labelledby="manual-attachment-title">
                  <div>
                    <h2 id="manual-attachment-title" className="font-semibold">
                      {t("credential.file")}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("credential.manual_upload_hint")}
                    </p>
                  </div>
                  <DocumentPicker
                    id="manual-document-upload"
                    busy={isUploading}
                    fileName={fileName}
                    compact
                    onChange={(event) => void handleFileUpload(event, false)}
                    t={t}
                  />
                </section>

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2 md:gap-6">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="credential-type">{t("credential.type")}</Label>
                    <Select
                      value={formData.type}
                      onValueChange={(value) =>
                        setFormData({ ...formData, type: value as CredentialInputType })
                      }
                    >
                      <SelectTrigger id="credential-type" className="min-h-11">
                        <SelectValue placeholder={t("credential.select_type")} />
                      </SelectTrigger>
                      <SelectContent>
                        {types.map((type) => (
                          <SelectItem key={type} value={type}>
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <FormField
                    id="holder-name"
                    label={`${t("credential.holder_name")} — ${t("credential.english")}`}
                    value={formData.holderName}
                    onChange={(value) => setFormData({ ...formData, holderName: value })}
                    required
                  />
                  <FormField
                    id="holder-name-ar"
                    label={`${t("credential.holder_name")} — ${t("credential.arabic")}`}
                    value={formData.holderNameAr}
                    onChange={(value) => setFormData({ ...formData, holderNameAr: value })}
                    dir="rtl"
                  />
                  <FormField
                    id="issuer-name"
                    label={`${t("credential.issuer")} — ${t("credential.english")}`}
                    value={formData.issuerName}
                    onChange={(value) => setFormData({ ...formData, issuerName: value })}
                    required
                  />
                  <FormField
                    id="issuer-name-ar"
                    label={`${t("credential.issuer")} — ${t("credential.arabic")}`}
                    value={formData.issuerNameAr}
                    onChange={(value) => setFormData({ ...formData, issuerNameAr: value })}
                    dir="rtl"
                  />
                  <FormField
                    id="certificate-number"
                    label={t("credential.certificate_number")}
                    value={formData.certificateNumber}
                    onChange={(value) =>
                      setFormData({ ...formData, certificateNumber: value })
                    }
                    required
                    className="md:col-span-2"
                  />
                  <FormField
                    id="issue-date"
                    label={t("credential.issue_date")}
                    type="date"
                    value={formData.issueDate}
                    onChange={(value) => setFormData({ ...formData, issueDate: value })}
                    required
                  />
                  <FormField
                    id="expiry-date"
                    label={t("credential.expiry_date")}
                    type="date"
                    min={formData.issueDate || undefined}
                    value={formData.expiryDate}
                    onChange={(value) => setFormData({ ...formData, expiryDate: value })}
                    required
                  />
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="credential-notes">{t("credential.notes")}</Label>
                    <Textarea
                      id="credential-notes"
                      value={formData.notes}
                      onChange={(event) =>
                        setFormData({ ...formData, notes: event.target.value })
                      }
                      rows={3}
                    />
                  </div>
                </div>

                <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setLocation("/credentials")}
                    className="min-h-11 w-full sm:w-auto"
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={createCredential.isPending || isUploading}
                    className="min-h-12 w-full gap-2 sm:w-auto"
                  >
                    {createCredential.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Check className="h-4 w-4" aria-hidden="true" />
                    )}
                    {t("credential.save_document")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DocumentPicker({
  id,
  busy,
  fileName,
  compact = false,
  onChange,
  t,
}: {
  id: string;
  busy: boolean;
  fileName: string;
  compact?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  t: (key: string) => string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border-2 border-dashed border-primary/25 bg-primary/5 transition-colors hover:bg-primary/10",
        compact ? "p-4" : "p-6 sm:p-10",
      )}
    >
      <input
        id={id}
        type="file"
        className="sr-only"
        accept={FILE_ACCEPT}
        onChange={onChange}
        disabled={busy}
      />
      <div className={cn("flex gap-4", compact ? "items-center" : "flex-col items-center text-center")}>
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary",
            compact ? "h-11 w-11" : "h-16 w-16",
          )}
        >
          {busy ? (
            <Loader2 className="h-7 w-7 animate-spin" aria-hidden="true" />
          ) : fileName ? (
            <FileCheck2 className="h-7 w-7" aria-hidden="true" />
          ) : (
            <UploadCloud className="h-7 w-7" aria-hidden="true" />
          )}
        </span>
        <div className={cn("min-w-0", compact && "flex-1")}>
          <p className={cn("font-semibold", !compact && "text-lg")}>
            {busy
              ? t("credential.scanning_title")
              : fileName || t("credential.upload_zone_title")}
          </p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {busy
              ? t("credential.scanning_hint")
              : fileName
                ? t("credential.file_ready")
                : t(compact ? "credential.manual_upload_hint" : "credential.upload_zone_hint")}
          </p>
        </div>
        <Button asChild variant={fileName ? "outline" : "default"} className="min-h-11 shrink-0">
          <label htmlFor={id} className={cn(busy && "pointer-events-none")}>
            {fileName ? t("credential.replace_file") : t("credential.choose_file")}
          </label>
        </Button>
      </div>
    </div>
  );
}

function FormField({
  id,
  label,
  value,
  onChange,
  type = "text",
  required,
  dir,
  min,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  dir?: "rtl" | "ltr";
  min?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        dir={dir}
        min={min}
        className="min-h-11"
      />
    </div>
  );
}
