import { useLanguage } from "@/lib/language-context";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building, Settings, Mail, MessageSquare, BellRing, Database, Lock } from "lucide-react";

export default function Integrations() {
  const { t } = useLanguage();

  const integrations = [
    {
      id: "mawared",
      name: "Mawared (HR)",
      description: "Sync employee data, roles, and departments automatically from Ministry of Health systems.",
      icon: Building,
      status: "connected",
      color: "text-blue-500",
      bg: "bg-blue-500/10"
    },
    {
      id: "scfhs",
      name: "SCFHS Mumaris+",
      description: "Verify Saudi Commission for Health Specialties licenses and CME hours automatically.",
      icon: Database,
      status: "coming_soon",
      color: "text-emerald-500",
      bg: "bg-emerald-500/10"
    },
    {
      id: "entra",
      name: "Microsoft Entra ID",
      description: "Single Sign-On (SSO) and Active Directory user lifecycle management.",
      icon: Lock,
      status: "available",
      color: "text-sky-500",
      bg: "bg-sky-500/10"
    },
    {
      id: "ldap",
      name: "On-Premise LDAP",
      description: "Legacy directory sync for local hospital network authentication.",
      icon: Settings,
      status: "available",
      color: "text-slate-500",
      bg: "bg-slate-500/10"
    },
    {
      id: "smtp",
      name: "SMTP Email",
      description: "Send credential expiry alerts and compliance reports via hospital email server.",
      icon: Mail,
      status: "connected",
      color: "text-indigo-500",
      bg: "bg-indigo-500/10"
    },
    {
      id: "sms",
      name: "SMS Gateway",
      description: "Critical alerts for immediate credential expirations via SMS.",
      icon: MessageSquare,
      status: "available",
      color: "text-amber-500",
      bg: "bg-amber-500/10"
    },
    {
      id: "push",
      name: "Push Notifications",
      description: "Mobile app push notifications for employees and managers.",
      icon: BellRing,
      status: "coming_soon",
      color: "text-purple-500",
      bg: "bg-purple-500/10"
    },
    {
      id: "api",
      name: "REST API & Webhooks",
      description: "Custom integration points for internal hospital software.",
      icon: Database,
      status: "available",
      color: "text-primary",
      bg: "bg-primary/10"
    }
  ];

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('integrations.title')}</h1>
          <p className="text-muted-foreground">{t('integrations.subtitle')}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {integrations.map((integration) => (
          <Card key={integration.id} className="relative overflow-hidden border-border/50 hover-elevate transition-all flex flex-col h-full">
            <CardContent className="p-6 flex-1 flex flex-col">
              <div className="flex justify-between items-start mb-6">
                <div className={`p-3 rounded-xl ${integration.bg}`}>
                  <integration.icon className={`h-8 w-8 ${integration.color}`} />
                </div>
                {integration.status === 'connected' && (
                  <Badge variant="default" className="bg-emerald-500 text-white hover:bg-emerald-600 shadow-none">
                    {t('integrations.connected')}
                  </Badge>
                )}
                {integration.status === 'coming_soon' && (
                  <Badge variant="secondary" className="font-normal bg-muted text-muted-foreground">
                    {t('common.coming_soon')}
                  </Badge>
                )}
              </div>
              
              <h3 className="text-xl font-bold mb-2">{integration.name}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed flex-1">
                {integration.description}
              </p>

              <div className="mt-6 pt-4 border-t border-border/50">
                <Button 
                  variant={integration.status === 'connected' ? 'outline' : 'default'} 
                  className="w-full"
                  disabled={integration.status === 'coming_soon'}
                >
                  {integration.status === 'connected' ? t('integrations.configure') : t('common.add')}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
