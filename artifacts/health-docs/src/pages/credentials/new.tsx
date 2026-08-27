import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileCheck2,
  Loader2,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import {
  CredentialInputType,
  getGetEmployeeQueryKey,
  useCreateCredential,
  useDeleteUnlinkedUpload,
  useGetEmployee,
  useRequestUploadUrl,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import {
  buildUploadRequestHeaders,
  prepareUploadFile,
  UploadTooLargeError,
} from "@/lib/upload";
import { cn } from "@/lib/utils";
import {
  claimCredentialSubmission,
  CredentialSubmissionError,
  getUnlinkedUploadId,
  releaseCredentialSubmission,
  submitCredentialWithDeferredUpload,
  type CredentialSubmissionStage,
} from "./deferred-credential-submission";
import { getCredentialOwnerState } from "./credential-owner-state";

const FILE_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,application/pdf";

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
  const isUploadingForAnotherEmployee = Boolean(
    employeeId && employeeId !== user?.id,
  );
  const targetEmployeeQuery = useGetEmployee(employeeId ?? 0, {
    query: {
      queryKey: getGetEmployeeQueryKey(employeeId ?? 0),
      enabled: isUploadingForAnotherEmployee,
    },
  });
  const targetEmployee = targetEmployeeQuery.data;
  const ownerState = getCredentialOwnerState({
    employeeId,
    currentUserId: user?.id,
    isLoading: targetEmployeeQuery.isLoading,
    isError: targetEmployeeQuery.isError,
    hasTargetEmployee: Boolean(targetEmployee),
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [submissionStage, setSubmissionStage] = useState<
    CredentialSubmissionStage | "idle"
  >("idle");
  const [cleanupUnconfirmed, setCleanupUnconfirmed] = useState(false);
  const submissionLock = useRef({ current: false });

  const createCredential = useCreateCredential({ mutation: { gcTime: 0 } });
  const requestUploadUrl = useRequestUploadUrl({ mutation: { gcTime: 0 } });
  const deleteUnlinkedUpload = useDeleteUnlinkedUpload({
    mutation: { gcTime: 0 },
  });

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

  const handleFileSelection = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSelectedFile(file);
  };

  const clearSelectedFile = () => setSelectedFile(null);
  const isSubmitting = submissionStage !== "idle";
  const controlsDisabled = isSubmitting || cleanupUnconfirmed;
  const resetSensitiveMutationState = () => {
    createCredential.reset();
    requestUploadUrl.reset();
    deleteUnlinkedUpload.reset();
  };

  const leaveForm = () => {
    if (submissionLock.current.current) return;
    clearSelectedFile();
    resetSensitiveMutationState();
    setLocation("/credentials");
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (ownerState !== "ready") {
      toast.error(t("credential.employee_required"));
      return;
    }
    if (formData.issueDate > formData.expiryDate) {
      toast.error(t("credential.date_order_error"));
      return;
    }
    if (cleanupUnconfirmed) {
      toast.error(t("credential.cleanup_failed"));
      return;
    }
    if (!claimCredentialSubmission(submissionLock.current)) return;

    let createdCredentialId: number | null = null;
    try {
      createdCredentialId = await submitCredentialWithDeferredUpload({
        file: selectedFile,
        prepareFile: prepareUploadFile,
        requestUpload: (file, prepared) =>
          requestUploadUrl.mutateAsync({
            data: {
              name: file.name,
              size: prepared.blob.size,
              contentType: prepared.contentType,
            },
          }),
        putUpload: async (grant, prepared) => {
          const response = await fetch(grant.uploadURL, {
            method: "PUT",
            body: prepared.blob,
            headers: buildUploadRequestHeaders(
              grant.requiredHeaders,
              prepared.contentType,
              grant.uploadURL,
              window.location.origin,
            ),
          });
          if (!response.ok) {
            throw new Error(`Storage upload failed (${response.status})`);
          }
        },
        createCredential: async (uploadedFile) => {
          const credential = await createCredential.mutateAsync({
            data: {
              ...formData,
              employeeId,
              fileUrl: uploadedFile?.objectPath,
              fileType: uploadedFile?.kind,
            },
          });
          return credential.id;
        },
        cleanupUpload: async (objectPath) => {
          const uploadId = getUnlinkedUploadId(objectPath);
          if (!uploadId) throw new Error("Invalid private upload reference");
          await deleteUnlinkedUpload.mutateAsync({ uploadId });
        },
        onStage: setSubmissionStage,
      });
    } catch (error) {
      const submissionError =
        error instanceof CredentialSubmissionError ? error : null;
      const underlyingError = submissionError?.originalError ?? error;
      if (
        submissionError?.stage === "upload" &&
        underlyingError instanceof UploadTooLargeError
      ) {
        toast.error(t("credential.file_too_large"));
      } else if (submissionError?.stage === "upload") {
        toast.error(t("credential.upload_failed"));
      } else if (submissionError?.stage === "cleanup") {
        setCleanupUnconfirmed(true);
        toast.error(t("credential.cleanup_failed"));
      } else {
        toast.error(t("credential.create_failed"));
      }
    } finally {
      releaseCredentialSubmission(submissionLock.current);
      resetSensitiveMutationState();
      setSubmissionStage("idle");
    }

    if (createdCredentialId !== null) {
      clearSelectedFile();
      toast.success(t("credential.create_success"));
      setLocation(`/credentials/${createdCredentialId}`);
    }
  };

  const types = Object.keys(CredentialInputType);

  return (
    <div className="mx-auto max-w-3xl space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 md:space-y-8">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={leaveForm}
          disabled={isSubmitting}
          aria-label={t("common.back")}
          className="h-11 w-11 shrink-0"
        >
          {isRTL ? (
            <ArrowRight className="h-5 w-5" />
          ) : (
            <ArrowLeft className="h-5 w-5" />
          )}
        </Button>
        <div>
          <p className="text-sm font-medium text-primary">
            {t("employee_portal.dashboard_eyebrow")}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            {t("credential.add_new")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            {t("credential.add_subtitle")}
          </p>
        </div>
      </div>

      {ownerState === "loading" && (
        <Card>
          <CardContent
            className="flex min-h-28 items-center justify-center gap-3 p-6 text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            {t("credential.owner_loading")}
          </CardContent>
        </Card>
      )}

      {ownerState === "error" && (
        <QueryErrorState
          error={targetEmployeeQuery.error}
          onRetry={() => void targetEmployeeQuery.refetch()}
        />
      )}

      {ownerState === "ready" && targetEmployee && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          {t("credential.uploading_for")}:{" "}
          <strong>{isRTL ? targetEmployee.nameAr : targetEmployee.name}</strong>
        </div>
      )}

      {ownerState === "ready" && (
        <>
          <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <p className="leading-6">
              {t("credential.private_upload_notice")}
            </p>
          </div>

          <Card>
            <CardContent className="p-4 sm:p-6">
              <form
                onSubmit={handleSubmit}
                className="space-y-6"
                aria-busy={isSubmitting}
              >
                <p className="sr-only" role="status" aria-live="polite">
                  {submissionStage === "upload"
                    ? t("credential.uploading_title")
                    : submissionStage === "create"
                      ? t("credential.saving_title")
                      : ""}
                </p>
                {cleanupUnconfirmed && (
                  <div
                    className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm leading-6 text-destructive"
                    role="alert"
                  >
                    {t("credential.cleanup_failed")}
                  </div>
                )}
                <section
                  className="space-y-3"
                  aria-labelledby="manual-attachment-title"
                >
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
                    busy={submissionStage === "upload"}
                    disabled={controlsDisabled}
                    fileName={selectedFile?.name ?? ""}
                    compact
                    onChange={handleFileSelection}
                    onClear={clearSelectedFile}
                    t={t}
                  />
                </section>

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2 md:gap-6">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="credential-type">
                      {t("credential.type")}
                    </Label>
                    <Select
                      value={formData.type}
                      disabled={controlsDisabled}
                      onValueChange={(value) =>
                        setFormData({
                          ...formData,
                          type: value as CredentialInputType,
                        })
                      }
                    >
                      <SelectTrigger id="credential-type" className="min-h-11">
                        <SelectValue
                          placeholder={t("credential.select_type")}
                        />
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
                    onChange={(value) =>
                      setFormData({ ...formData, holderName: value })
                    }
                    dir="ltr"
                    required
                    disabled={controlsDisabled}
                  />
                  <FormField
                    id="holder-name-ar"
                    label={`${t("credential.holder_name")} — ${t("credential.arabic")}`}
                    value={formData.holderNameAr}
                    onChange={(value) =>
                      setFormData({ ...formData, holderNameAr: value })
                    }
                    dir="rtl"
                    disabled={controlsDisabled}
                  />
                  <FormField
                    id="issuer-name"
                    label={`${t("credential.issuer")} — ${t("credential.english")}`}
                    value={formData.issuerName}
                    onChange={(value) =>
                      setFormData({ ...formData, issuerName: value })
                    }
                    dir="ltr"
                    required
                    disabled={controlsDisabled}
                  />
                  <FormField
                    id="issuer-name-ar"
                    label={`${t("credential.issuer")} — ${t("credential.arabic")}`}
                    value={formData.issuerNameAr}
                    onChange={(value) =>
                      setFormData({ ...formData, issuerNameAr: value })
                    }
                    dir="rtl"
                    disabled={controlsDisabled}
                  />
                  <FormField
                    id="certificate-number"
                    label={t("credential.certificate_number")}
                    value={formData.certificateNumber}
                    onChange={(value) =>
                      setFormData({ ...formData, certificateNumber: value })
                    }
                    required
                    dir="ltr"
                    className="md:col-span-2"
                    disabled={controlsDisabled}
                  />
                  <FormField
                    id="issue-date"
                    label={t("credential.issue_date")}
                    type="date"
                    value={formData.issueDate}
                    onChange={(value) =>
                      setFormData({ ...formData, issueDate: value })
                    }
                    required
                    dir="ltr"
                    disabled={controlsDisabled}
                  />
                  <FormField
                    id="expiry-date"
                    label={t("credential.expiry_date")}
                    type="date"
                    min={formData.issueDate || undefined}
                    value={formData.expiryDate}
                    onChange={(value) =>
                      setFormData({ ...formData, expiryDate: value })
                    }
                    required
                    dir="ltr"
                    disabled={controlsDisabled}
                  />
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="credential-notes">
                      {t("credential.notes")}
                    </Label>
                    <Textarea
                      id="credential-notes"
                      value={formData.notes}
                      onChange={(event) =>
                        setFormData({ ...formData, notes: event.target.value })
                      }
                      rows={3}
                      disabled={controlsDisabled}
                    />
                  </div>
                </div>

                <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={leaveForm}
                    disabled={isSubmitting}
                    className="min-h-11 w-full sm:w-auto"
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={controlsDisabled || ownerState !== "ready"}
                    className="min-h-12 w-full gap-2 sm:w-auto"
                  >
                    {isSubmitting ? (
                      <Loader2
                        className="h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Check className="h-4 w-4" aria-hidden="true" />
                    )}
                    {submissionStage === "upload"
                      ? t("credential.uploading_title")
                      : submissionStage === "create"
                        ? t("credential.saving_title")
                        : t("credential.save_document")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function DocumentPicker({
  id,
  busy,
  disabled = false,
  fileName,
  compact = false,
  onChange,
  onClear,
  t,
}: {
  id: string;
  busy: boolean;
  disabled?: boolean;
  fileName: string;
  compact?: boolean;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  t: (key: string) => string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      aria-busy={busy}
      className={cn(
        "rounded-2xl border-2 border-dashed border-primary/25 bg-primary/5 transition-colors hover:bg-primary/10",
        disabled && "opacity-70 hover:bg-primary/5",
        compact ? "p-4" : "p-6 sm:p-10",
      )}
    >
      <input
        id={id}
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept={FILE_ACCEPT}
        onChange={onChange}
        disabled={busy || disabled}
      />
      <div
        className={cn(
          "flex min-w-0 gap-4",
          compact
            ? "flex-wrap items-center sm:flex-nowrap"
            : "flex-col items-center text-center",
        )}
      >
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
          <p
            className={cn(
              "font-semibold",
              compact ? "truncate" : "text-lg",
            )}
            role="status"
            aria-live="polite"
          >
            {busy
              ? t("credential.uploading_title")
              : fileName || t("credential.choose_file")}
          </p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {busy
              ? t("credential.uploading_hint")
              : fileName
                ? t("credential.file_ready")
                : t("credential.manual_upload_hint")}
          </p>
        </div>
        <div
          className={cn(
            "grid shrink-0 grid-cols-1 gap-2",
            compact && "w-full sm:flex sm:w-auto",
          )}
        >
          {fileName && (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy || disabled}
              onClick={onClear}
            >
              {t("credential.remove_file")}
            </Button>
          )}
          <Button
            type="button"
            variant={fileName ? "outline" : "default"}
            className="min-h-11"
            disabled={busy || disabled}
            onClick={() => inputRef.current?.click()}
          >
            {fileName
              ? t("credential.replace_file")
              : t("credential.choose_file")}
          </Button>
        </div>
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
  disabled,
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
  disabled?: boolean;
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
        disabled={disabled}
        className="min-h-11"
      />
    </div>
  );
}
