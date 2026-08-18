import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getGetEmployeeQueryKey, useCreateCredential, useExtractCredentialOcr, useGetEmployee, useRequestUploadUrl, CredentialInputType } from "@workspace/api-client-react";
import { prepareUploadFile, UploadTooLargeError } from "@/lib/upload";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { UploadCloud, FileText, Check, Loader2, ArrowRight, ArrowLeft, Info } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getAuthUser } from "@/lib/auth";

export default function CredentialNew() {
  const { t, isRTL } = useLanguage();
  const [, setLocation] = useLocation();
  const user = getAuthUser();
  const requestedEmployeeId = Number(
    new URLSearchParams(window.location.search).get("employeeId"),
  );
  const employeeId =
    Number.isInteger(requestedEmployeeId) && requestedEmployeeId > 0
      ? requestedEmployeeId
      : user?.id;
  const { data: targetEmployee } = useGetEmployee(employeeId ?? 0, {
    query: {
      queryKey: getGetEmployeeQueryKey(employeeId ?? 0),
      enabled: Boolean(employeeId && employeeId !== user?.id),
    },
  });
  
  const [activeTab, setActiveTab] = useState("smart");
  const [fileUrl, setFileUrl] = useState<string>("");
  const [fileKind, setFileKind] = useState<"pdf" | "image" | "">("");
  const [isUploading, setIsUploading] = useState(false);
  
  const extractOcr = useExtractCredentialOcr();
  const createCred = useCreateCredential();
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
    notes: ""
  });

  useEffect(() => {
    if (!targetEmployee) return;
    setFormData((previous) => ({
      ...previous,
      holderName: targetEmployee.name,
      holderNameAr: targetEmployee.nameAr,
    }));
  }, [targetEmployee]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so choosing the same file again re-triggers onChange after an error.
    e.target.value = "";
    if (!file) return;

    // Photos are downscaled in the browser, then the bytes go straight to
    // object storage via a presigned URL — the API only ever sees the file's
    // storage path, so credential records stay small and listings stay fast.
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
      const put = await fetch(granted.uploadURL, {
        method: "PUT",
        body: prepared.blob,
        headers: { "Content-Type": prepared.contentType },
      });
      if (!put.ok) throw new Error(`Storage upload failed (${put.status})`);

      setFileUrl(granted.objectPath);
      setFileKind(prepared.kind);

      // Call OCR
      extractOcr.mutate({ data: { fileUrl: granted.objectPath, fileName: file.name } }, {
        onSuccess: (res) => {
          toast.success(t('credential.scan_success'));
          setFormData(prev => ({
            ...prev,
            type: (res.detectedType as CredentialInputType) || "BLS",
            holderName: res.holderName || prev.holderName,
            holderNameAr: res.holderNameAr || prev.holderNameAr,
            issuerName: res.issuerName || "",
            issuerNameAr: res.issuerNameAr || "",
            certificateNumber: res.certificateNumber || "",
            issueDate: res.issueDate ? res.issueDate.split('T')[0] : "",
            expiryDate: res.expiryDate ? res.expiryDate.split('T')[0] : "",
          }));
          setActiveTab("manual"); // Move to manual to review
        },
        onError: () => {
          toast.error(t('credential.scan_failed'));
          setActiveTab("manual");
        }
      });
    } catch (err) {
      toast.error(t(err instanceof UploadTooLargeError ? 'credential.file_too_large' : 'credential.upload_failed'));
      return;
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId) {
      toast.error("No employee was selected for this credential");
      return;
    }

    createCred.mutate({
      data: {
        ...formData,
        employeeId,
        fileUrl: fileUrl || undefined,
        fileType: fileUrl ? (fileKind || "image") : undefined
      }
    }, {
      onSuccess: (res) => {
        toast.success("Credential added successfully");
        setLocation(`/credentials/${res.id}`);
      },
      onError: (err: any) => {
        toast.error(err?.message || "Failed to create credential");
      }
    });
  };

  const types = Object.keys(CredentialInputType);

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-4 mb-8">
        <Button variant="ghost" size="icon" onClick={() => setLocation('/credentials')}>
          {isRTL ? <ArrowRight className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('credential.add_new')}</h1>
          <p className="text-muted-foreground mt-1">{t('credential.add_subtitle')}</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-2 mb-8">
          <TabsTrigger value="smart" className="gap-2">
            <UploadCloud className="h-4 w-4" />
            {t('credential.smart_scan')}
          </TabsTrigger>
          <TabsTrigger value="manual" className="gap-2">
            <FileText className="h-4 w-4" />
            {t('credential.manual')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="smart" className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
            <Info className="h-5 w-5 shrink-0 mt-0.5" />
            <p>{t('credential.ocr_review_notice')}</p>
          </div>
          <Card className="border-2 border-dashed border-primary/20 bg-primary/5 hover:bg-primary/10 transition-colors">
            <CardContent className="flex flex-col items-center justify-center py-24 text-center relative">
              <input 
                type="file" 
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" 
                accept="image/*,.pdf"
                onChange={handleFileUpload}
                disabled={isUploading || extractOcr.isPending}
              />
              {isUploading || extractOcr.isPending ? (
                <>
                  <Loader2 className="h-16 w-16 text-primary animate-spin mb-4" />
                  <h3 className="text-xl font-semibold">{t('credential.scanning_title')}</h3>
                  <p className="text-muted-foreground mt-2">{t('credential.scanning_hint')}</p>
                </>
              ) : (
                <>
                  <div className="h-20 w-20 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                    <UploadCloud className="h-10 w-10 text-primary" />
                  </div>
                  <h3 className="text-xl font-semibold text-foreground">{t('credential.upload_zone_title')}</h3>
                  <p className="text-muted-foreground mt-2 max-w-sm">
                    {t('credential.upload_zone_hint')}
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="manual">
          <Card>
            <CardContent className="p-6">
              <form onSubmit={handleSubmit} className="space-y-6">
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2 md:col-span-2">
                    <Label>{t('credential.type')}</Label>
                    <Select 
                      value={formData.type} 
                      onValueChange={(v) => setFormData({...formData, type: v as CredentialInputType})}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select type..." />
                      </SelectTrigger>
                      <SelectContent>
                        {types.map(t => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>{t('credential.holder_name')} (English)</Label>
                    <Input 
                      value={formData.holderName} 
                      onChange={(e) => setFormData({...formData, holderName: e.target.value})} 
                      required 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('credential.holder_name')} (Arabic)</Label>
                    <Input 
                      value={formData.holderNameAr} 
                      onChange={(e) => setFormData({...formData, holderNameAr: e.target.value})} 
                      dir="rtl"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>{t('credential.issuer')} (English)</Label>
                    <Input 
                      value={formData.issuerName} 
                      onChange={(e) => setFormData({...formData, issuerName: e.target.value})} 
                      required 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('credential.issuer')} (Arabic)</Label>
                    <Input 
                      value={formData.issuerNameAr} 
                      onChange={(e) => setFormData({...formData, issuerNameAr: e.target.value})} 
                      dir="rtl"
                    />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label>{t('credential.certificate_number')}</Label>
                    <Input 
                      value={formData.certificateNumber} 
                      onChange={(e) => setFormData({...formData, certificateNumber: e.target.value})} 
                      required 
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>{t('credential.issue_date')}</Label>
                    <Input 
                      type="date" 
                      value={formData.issueDate} 
                      onChange={(e) => setFormData({...formData, issueDate: e.target.value})} 
                      required 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('credential.expiry_date')}</Label>
                    <Input 
                      type="date" 
                      value={formData.expiryDate} 
                      onChange={(e) => setFormData({...formData, expiryDate: e.target.value})} 
                      required 
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-4 mt-8 pt-6 border-t border-border">
                  <Button type="button" variant="outline" onClick={() => setLocation('/credentials')}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="submit" disabled={createCred.isPending} className="gap-2">
                    {createCred.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    <Check className="h-4 w-4" />
                    {t('common.save')}
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
