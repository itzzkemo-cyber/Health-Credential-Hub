import { useState } from "react";
import { Link } from "wouter";
import { useForgotPassword } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, ArrowRight, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export default function ForgotPassword() {
  const { t } = useLanguage();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const forgotPasswordMutation = useForgotPassword();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    forgotPasswordMutation.mutate(
      { data: { email } },
      {
        onSuccess: () => {
          setSubmitted(true);
        },
        onError: () => {
          // Even on error we usually show success for security, 
          // or we can show a specific error if the backend wants
          setSubmitted(true);
        }
      }
    );
  };

  const ArrowIcon = document.documentElement.dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center text-primary mb-4">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h2 className="text-3xl font-bold tracking-tight">
            {submitted ? t('forgot_password.success_title') : t('forgot_password.title')}
          </h2>
          <p className="text-muted-foreground">
            {submitted ? t('forgot_password.success_message') : t('forgot_password.subtitle')}
          </p>
        </div>

        {!submitted ? (
          <form onSubmit={handleSubmit} className="space-y-6 bg-card p-8 rounded-2xl border shadow-sm">
            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
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
            <Button type="submit" className="w-full h-11 text-lg font-semibold" disabled={forgotPasswordMutation.isPending}>
              {forgotPasswordMutation.isPending ? t('common.loading') : t('forgot_password.send_link')}
            </Button>
          </form>
        ) : (
          <div className="bg-card p-8 rounded-2xl border shadow-sm flex flex-col items-center text-center space-y-6">
            <div className="h-16 w-16 bg-green-500/10 rounded-full flex items-center justify-center text-green-500 mb-2">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm font-medium">{email}</p>
          </div>
        )}

        <div className="text-center">
          <Link href="/login" className="inline-flex items-center gap-2 text-sm text-primary hover:underline font-medium">
            <ArrowIcon className="h-4 w-4" />
            {t('forgot_password.back_to_login')}
          </Link>
        </div>
      </div>
    </div>
  );
}
