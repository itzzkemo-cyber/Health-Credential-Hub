import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileCheck2,
  Loader2,
  ScanText,
  ShieldAlert,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import {
  CredentialInputType,
  type OcrResult,
  getGetCredentialOcrReadinessQueryKey,
  getGetEmployeeQueryKey,
  getReadinessCheckQueryKey,
  useCreateCredential,
  useDeleteUnlinkedUpload,
  useExtractCredentialOcr,
  useGetEmployee,
  useGetCredentialOcrReadiness,
  useReadinessCheck,
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
  isSupportedUploadFile,
  prepareUploadFile,
  UnsupportedUploadTypeError,
  UPLOAD_ACCEPT_ATTRIBUTE,
  UploadTooLargeError,
} from "@/lib/upload";
import { cn } from "@/lib/utils";
import { getDocumentUploadAvailability } from "@/lib/document-upload-availability";
import {
  claimCredentialSubmission,
  CredentialSubmissionError,
  getUnlinkedUploadId,
  releaseCredentialSubmission,
  submitCredentialWithDeferredUpload,
  type CredentialSubmissionStage,
} from "./deferred-credential-submission";
import { getCredentialOwnerState } from "./credential-owner-state";
import { applyReviewedOcrSuggestions, getOcrAvailability } from "./ocr-review";

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
  const readinessQuery = useReadinessCheck({
    query: {
      queryKey: getReadinessCheckQueryKey(),
      retry: false,
      staleTime: 60_000,
    },
  });
  const documentUploadAvailability = getDocumentUploadAvailability({
    readiness: readinessQuery.data,
    isLoading: readinessQuery.isLoading,
    isError: readinessQuery.isError,
  });
  const documentUploadsEnabled = documentUploadAvailability === "enabled";
  const ocrReadinessQuery = useGetCredentialOcrReadiness(
    { employeeId: employeeId ?? undefined },
    {
      query: {
        queryKey: getGetCredentialOcrReadinessQueryKey({
          employeeId: employeeId ?? undefined,
        }),
        enabled: Boolean(employeeId) && documentUploadsEnabled,
        retry: false,
        staleTime: 60_000,
      },
    },
  );
  const ocrAvailability = getOcrAvailability({
    readiness: ocrReadinessQuery.data,
    isLoading: ocrReadinessQuery.isLoading,
    isError: ocrReadinessQuery.isError,
  });
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
  const [ocrStage, setOcrStage] = useState<
    "idle" | "upload" | "read" | "cleanup"
  >("idle");
  const [ocrUploadedFile, setOcrUploadedFile] = useState<{
    objectPath: string;
    kind: "image";
  } | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const submissionLock = useRef({ current: false });
  const ocrLock = useRef(false);

  const createCredential = useCreateCredential({ mutation: { gcTime: 0 } });
  const requestUploadUrl = useRequestUploadUrl({ mutation: { gcTime: 0 } });
  const deleteUnlinkedUpload = useDeleteUnlinkedUpload({
    mutation: { gcTime: 0 },
  });
  const extractCredentialOcr = useExtractCredentialOcr({
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

  const isSubmitting = submissionStage !== "idle";
  const ocrBusy = ocrStage !== "idle";
  const controlsDisabled = isSubmitting || ocrBusy || cleanupUnconfirmed;
  const resetSensitiveMutationState = () => {
    createCredential.reset();
    requestUploadUrl.reset();
    deleteUnlinkedUpload.reset();
    extractCredentialOcr.reset();
  };

  const putPreparedUpload = async (
    grant: {
      uploadURL: string;
      requiredHeaders: Record<string, string>;
    },
    prepared: {
      blob: Blob;
      contentType: "image/jpeg" | "image/png" | "application/pdf";
    },
  ) => {
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
  };

  const deleteUploadedOcrFile = async (): Promise<boolean> => {
    if (!ocrUploadedFile) return true;
    const uploadId = getUnlinkedUploadId(ocrUploadedFile.objectPath);
    if (!uploadId) {
      setCleanupUnconfirmed(true);
      toast.error(t("credential.cleanup_failed"));
      return false;
    }
    setOcrStage("cleanup");
    try {
      await deleteUnlinkedUpload.mutateAsync({ uploadId });
      setOcrUploadedFile(null);
      setOcrResult(null);
      return true;
    } catch {
      setCleanupUnconfirmed(true);
      toast.error(t("credential.cleanup_failed"));
      return false;
    } finally {
      setOcrStage("idle");
    }
  };

  const handleFileSelection = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (!documentUploadsEnabled || controlsDisabled) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!isSupportedUploadFile(file)) {
      toast.error(t("credential.file_type_unsupported"));
      return;
    }
    if (!(await deleteUploadedOcrFile())) return;
    setSelectedFile(file);
    setOcrResult(null);
  };

  const clearSelectedFile = async () => {
    if (!(await deleteUploadedOcrFile())) return;
    setSelectedFile(null);
    setOcrResult(null);
  };

  const leaveForm = async () => {
    if (submissionLock.current.current || ocrLock.current) return;
    if (!(await deleteUploadedOcrFile())) return;
    setSelectedFile(null);
    resetSensitiveMutationState();
    setLocation("/credentials");
  };

  const readSelectedDocument = async () => {
    if (
      !selectedFile ||
      selectedFile.type === "application/pdf" ||
      !employeeId ||
      ocrAvailability !== "enabled" ||
      cleanupUnconfirmed ||
      ocrLock.current
    ) {
      return;
    }

    ocrLock.current = true;
    let grantedObjectPath: string | null = null;
    try {
      let uploadedFile = ocrUploadedFile;
      if (!uploadedFile) {
        setOcrStage("upload");
        const prepared = await prepareUploadFile(selectedFile);
        const grant = await requestUploadUrl.mutateAsync({
          data: {
            name: selectedFile.name,
            size: prepared.blob.size,
            contentType: prepared.contentType,
          },
        });
        grantedObjectPath = grant.objectPath;
        await putPreparedUpload(grant, prepared);
        uploadedFile = { objectPath: grant.objectPath, kind: "image" };
        setOcrUploadedFile(uploadedFile);
      }

      setOcrStage("read");
      const result = await extractCredentialOcr.mutateAsync({
        data: { fileUrl: uploadedFile.objectPath, employeeId },
      });
      setOcrResult(result);
      toast.success(t("credential.ocr_read_success"));
    } catch (error) {
      if (grantedObjectPath) {
        const uploadId = getUnlinkedUploadId(grantedObjectPath);
        try {
          if (!uploadId) throw new Error("Invalid private upload reference");
          await deleteUnlinkedUpload.mutateAsync({ uploadId });
          setOcrUploadedFile(null);
        } catch {
          setCleanupUnconfirmed(true);
          toast.error(t("credential.cleanup_failed"));
          return;
        }
      }

      if (error instanceof UploadTooLargeError) {
        toast.error(t("credential.file_too_large"));
      } else if (error instanceof UnsupportedUploadTypeError) {
        toast.error(t("credential.file_type_unsupported"));
      } else {
        toast.error(t("credential.ocr_read_failed"));
      }
    } finally {
      ocrLock.current = false;
      setOcrStage("idle");
    }
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
    if (selectedFile && !documentUploadsEnabled) {
      await clearSelectedFile();
      toast.error(t("credential.upload_unavailable_desc"));
      return;
    }
    if (!claimCredentialSubmission(submissionLock.current)) return;

    let createdCredentialId: number | null = null;
    const reusedOcrUpload = ocrUploadedFile != null;
    try {
      createdCredentialId = await submitCredentialWithDeferredUpload({
        file: ocrUploadedFile ? null : selectedFile,
        existingUpload: ocrUploadedFile ?? undefined,
        prepareFile: prepareUploadFile,
        requestUpload: (file, prepared) =>
          requestUploadUrl.mutateAsync({
            data: {
              name: file.name,
              size: prepared.blob.size,
              contentType: prepared.contentType,
            },
          }),
        putUpload: putPreparedUpload,
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
      if (reusedOcrUpload) {
        setOcrUploadedFile(null);
        setOcrResult(null);
      }
      const submissionError =
        error instanceof CredentialSubmissionError ? error : null;
      const underlyingError = submissionError?.originalError ?? error;
      if (
        submissionError?.stage === "upload" &&
        underlyingError instanceof UploadTooLargeError
      ) {
        toast.error(t("credential.file_too_large"));
      } else if (
        submissionError?.stage === "upload" &&
        underlyingError instanceof UnsupportedUploadTypeError
      ) {
        toast.error(t("credential.file_type_unsupported"));
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
      setOcrUploadedFile(null);
      setOcrResult(null);
      setSelectedFile(null);
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
          onClick={() => void leaveForm()}
          disabled={controlsDisabled}
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
          {documentUploadsEnabled ? (
            <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
              <ShieldCheck
                className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                aria-hidden="true"
              />
              <p className="leading-6">
                {t("credential.private_upload_notice")}
              </p>
            </div>
          ) : (
            <div
              className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
              role="status"
              aria-live="polite"
            >
              {documentUploadAvailability === "checking" ? (
                <Loader2
                  className="mt-0.5 h-5 w-5 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <ShieldAlert
                  className="mt-0.5 h-5 w-5 shrink-0"
                  aria-hidden="true"
                />
              )}
              <div className="space-y-1">
                <p className="font-semibold">
                  {t(
                    documentUploadAvailability === "checking"
                      ? "credential.upload_checking_title"
                      : "credential.upload_unavailable_title",
                  )}
                </p>
                <p className="leading-6">
                  {t(
                    documentUploadAvailability === "checking"
                      ? "credential.upload_checking_desc"
                      : "credential.upload_unavailable_desc",
                  )}
                </p>
              </div>
            </div>
          )}

          <Card>
            <CardContent className="p-4 sm:p-6">
              <form
                onSubmit={handleSubmit}
                className="space-y-6"
                aria-busy={controlsDisabled}
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
                      {t(
                        documentUploadsEnabled
                          ? "credential.manual_upload_hint"
                          : "credential.record_without_attachment_hint",
                      )}
                    </p>
                  </div>
                  <DocumentPicker
                    id="manual-document-upload"
                    busy={
                      submissionStage === "upload" ||
                      ocrStage === "upload" ||
                      ocrStage === "cleanup"
                    }
                    disabled={controlsDisabled || !documentUploadsEnabled}
                    fileName={selectedFile?.name ?? ""}
                    compact
                    onChange={handleFileSelection}
                    onClear={() => void clearSelectedFile()}
                    t={t}
                  />
                  {selectedFile?.type === "application/pdf" && (
                    <p
                      className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6"
                      role="status"
                    >
                      {t("credential.pdf_processing_notice")}
                    </p>
                  )}
                  {selectedFile &&
                    selectedFile.type !== "application/pdf" &&
                    ocrAvailability === "enabled" && (
                      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="font-semibold">
                              {t("credential.ocr_title")}
                            </p>
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">
                              {t("credential.ocr_disclosure")}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 w-full shrink-0 gap-2 sm:w-auto"
                            disabled={controlsDisabled}
                            onClick={() => void readSelectedDocument()}
                          >
                            {ocrStage === "upload" || ocrStage === "read" ? (
                              <Loader2
                                className="h-4 w-4 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <ScanText
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                            )}
                            {ocrStage === "upload"
                              ? t("credential.ocr_uploading")
                              : ocrStage === "read"
                                ? t("credential.ocr_reading")
                                : t("credential.ocr_read_action")}
                          </Button>
                        </div>
                      </div>
                    )}
                  {selectedFile &&
                    selectedFile.type !== "application/pdf" &&
                    ocrAvailability !== "enabled" && (
                      <p
                        className="text-sm leading-6 text-muted-foreground"
                        role="status"
                      >
                        {t(
                          ocrAvailability === "checking"
                            ? "credential.ocr_checking"
                            : "credential.ocr_unavailable",
                        )}
                      </p>
                    )}
                  {ocrResult && (
                    <OcrReviewCard
                      result={ocrResult}
                      busy={controlsDisabled}
                      isRTL={isRTL}
                      onApply={() => {
                        setFormData((current) =>
                          applyReviewedOcrSuggestions(current, ocrResult),
                        );
                        toast.success(t("credential.ocr_review_applied"));
                      }}
                      t={t}
                    />
                  )}
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
                    onClick={() => void leaveForm()}
                    disabled={controlsDisabled}
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

function OcrReviewCard({
  result,
  busy,
  isRTL,
  onApply,
  t,
}: {
  result: OcrResult;
  busy: boolean;
  isRTL: boolean;
  onApply: () => void;
  t: (key: string) => string;
}) {
  const suggestions = [
    [t("credential.type"), result.detectedType],
    [
      `${t("credential.holder_name")} — ${t("credential.english")}`,
      result.holderName,
    ],
    [
      `${t("credential.holder_name")} — ${t("credential.arabic")}`,
      result.holderNameAr,
    ],
    [
      `${t("credential.issuer")} — ${t("credential.english")}`,
      result.issuerName,
    ],
    [
      `${t("credential.issuer")} — ${t("credential.arabic")}`,
      result.issuerNameAr,
    ],
    [t("credential.certificate_number"), result.certificateNumber],
    [t("credential.issue_date"), result.issueDate],
    [t("credential.expiry_date"), result.expiryDate],
  ] as const;
  const confidence = Math.round(result.confidence.overall * 100);

  return (
    <section
      className="space-y-4 rounded-xl border border-primary/30 bg-card p-4"
      aria-labelledby="ocr-review-title"
    >
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="ocr-review-title" className="font-semibold">
            {t("credential.ocr_review_title")}
          </h3>
          <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            {t("credential.ocr_confidence")}: {confidence}%
          </span>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t("credential.ocr_review_notice")}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {suggestions.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-muted/60 px-3 py-2">
            <dt className="text-xs font-medium text-muted-foreground">
              {label}
            </dt>
            <dd
              className="mt-1 break-words text-sm font-medium"
              dir={isRTL ? "auto" : undefined}
            >
              {value || t("credential.ocr_not_detected")}
            </dd>
          </div>
        ))}
      </dl>
      <Button
        type="button"
        className="min-h-11 w-full sm:w-auto"
        disabled={busy}
        onClick={onApply}
      >
        {t("credential.ocr_apply_reviewed")}
      </Button>
    </section>
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
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
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
            className={cn("font-semibold", compact ? "truncate" : "text-lg")}
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
