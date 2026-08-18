import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import {
  useRegister,
  useGetFacilities,
  ApiError,
  type AuthResponse,
} from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { setAuthSession } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck, ArrowRight, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export default function Register() {
  const { t } = useLanguage();
  const [, setLocation] = useLocation();
  const [nameAr, setNameAr] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [facilityId, setFacilityId] = useState("");

  const registerMutation = useRegister();
  const { data: facilities } = useGetFacilities();
  const facilityOptions = facilities ?? [];
  const isRTL = document.documentElement.dir === "rtl";

  // With a single facility there is nothing to choose — preselect it.
  useEffect(() => {
    if (!facilityId && facilityOptions.length === 1) {
      setFacilityId(String(facilityOptions[0].id));
    }
  }, [facilityOptions, facilityId]);

  const onAuthenticated = (res: AuthResponse) => {
    setAuthSession(res.user);
    toast.success(t("register.success"));
    setLocation("/");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error(t("register.password_hint"));
      return;
    }
    if (!facilityId) {
      toast.error(t("register.facility_placeholder"));
      return;
    }
    registerMutation.mutate(
      {
        data: {
          name: name.trim(),
          nameAr: nameAr.trim(),
          email: email.trim(),
          password,
          phone: phone.trim() ? phone.trim() : null,
          facilityId: Number(facilityId),
        },
      },
      {
        onSuccess: onAuthenticated,
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            toast.error(t("register.email_taken"));
          } else {
            toast.error(t("register.failed"));
          }
        },
      },
    );
  };

  const ArrowIcon = isRTL ? ArrowRight : ArrowLeft;

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center text-primary mb-4">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight">{t("register.title")}</h2>
          <p className="text-muted-foreground">{t("register.subtitle")}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-5 bg-card p-8 rounded-2xl border shadow-sm"
        >
          <div className="space-y-2">
            <Label htmlFor="nameAr">{t("register.name_ar")}</Label>
            <Input
              id="nameAr"
              required
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              className="h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">{t("register.name_en")}</Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              dir="ltr"
              className="h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input
              id="email"
              type="email"
              required
              placeholder="name@hospital.sa"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              dir="ltr"
              className="h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("auth.password")}</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              dir="ltr"
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">{t("register.password_hint")}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">{t("register.phone")}</Label>
            <Input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              dir="ltr"
              placeholder="05xxxxxxxx"
              className="h-11"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("register.facility")}</Label>
            <Select value={facilityId} onValueChange={setFacilityId}>
              <SelectTrigger className="h-11 w-full" id="facility">
                <SelectValue placeholder={t("register.facility_placeholder")} />
              </SelectTrigger>
              <SelectContent>
                {facilityOptions.map((f) => (
                  <SelectItem key={f.id} value={String(f.id)}>
                    {isRTL ? f.nameAr : f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            type="submit"
            className="w-full h-11 text-lg font-semibold"
            disabled={registerMutation.isPending}
          >
            {registerMutation.isPending ? t("common.loading") : t("register.submit")}
          </Button>
        </form>

        <div className="text-center">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-sm text-primary hover:underline font-medium"
          >
            <ArrowIcon className="h-4 w-4" />
            {t("register.have_account")} {t("auth.login")}
          </Link>
        </div>
      </div>
    </div>
  );
}
