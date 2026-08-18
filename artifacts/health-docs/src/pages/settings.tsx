import { useLanguage } from "@/lib/language-context";
import { useTheme } from "@/components/theme-provider";
import TwoFactorCard from "@/components/settings/TwoFactorCard";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Globe, Moon, Bell, CalendarDays } from "lucide-react";

export default function Settings() {
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme } = useTheme();

  const handleSave = () => {
    toast.success("Settings saved successfully");
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('common.settings')}</h1>
        <p className="text-muted-foreground mt-1">Manage your application preferences.</p>
      </div>

      <div className="grid gap-6">

        <TwoFactorCard />

        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              <CardTitle>Language & Region</CardTitle>
            </div>
            <CardDescription>Configure the language and locale settings.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Interface Language</Label>
                <p className="text-sm text-muted-foreground">Changes the text and layout direction.</p>
              </div>
              <Select value={language} onValueChange={(v) => setLanguage(v as 'ar' | 'en')}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Language" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ar">العربية (Arabic)</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Calendar System</Label>
                <p className="text-sm text-muted-foreground">Use Hijri dates across the platform.</p>
              </div>
              <Switch />
            </div>
          </CardContent>
        </Card>

        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Moon className="h-5 w-5 text-primary" />
              <CardTitle>Appearance</CardTitle>
            </div>
            <CardDescription>Customize how HealthDocs looks on your device.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Theme</Label>
                <p className="text-sm text-muted-foreground">Select your preferred color theme.</p>
              </div>
              <Select value={theme} onValueChange={(v) => setTheme(v as any)}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Theme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light Mode</SelectItem>
                  <SelectItem value="dark">Dark Mode</SelectItem>
                  <SelectItem value="system">System Default</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card className="hover-elevate">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-primary" />
              <CardTitle>Notification Preferences</CardTitle>
            </div>
            <CardDescription>Control when and how you receive alerts.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Expiry Warnings (Email)</Label>
                <p className="text-sm text-muted-foreground">Receive emails before credentials expire.</p>
              </div>
              <Switch defaultChecked />
            </div>
            
            <div className="space-y-3 pt-4 border-t border-border">
              <Label>Warning Thresholds (Days before expiry)</Label>
              <div className="flex flex-wrap gap-4">
                {['90', '60', '30', '15', '7', '1'].map((days) => (
                  <label key={days} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" defaultChecked={['60', '30', '7'].includes(days)} className="rounded border-input text-primary focus:ring-primary" />
                    {days} Days
                  </label>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-4 mt-4">
          <Button variant="outline">Reset Defaults</Button>
          <Button onClick={handleSave}>{t('common.save')}</Button>
        </div>

      </div>
    </div>
  );
}
