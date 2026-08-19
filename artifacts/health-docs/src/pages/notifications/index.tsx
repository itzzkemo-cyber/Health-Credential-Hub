import { useListNotifications, useMarkNotificationRead, useMarkAllNotificationsRead, getListNotificationsQueryKey, getGetUnreadCountQueryKey } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bell, Check, Clock, ShieldAlert, FileWarning, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { format, isToday, isYesterday } from "date-fns";

export default function Notifications() {
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();

  const { data: notifications, isLoading } = useListNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const handleMarkRead = (id: number) => {
    markRead.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetUnreadCountQueryKey() });
      }
    });
  };

  const handleMarkAllRead = () => {
    markAllRead.mutate(undefined, {
      onSuccess: () => {
        toast.success(t('notifications.read_success'));
        queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetUnreadCountQueryKey() });
      }
    });
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'expiry_warning': return <Clock className="h-5 w-5 text-amber-500" />;
      case 'expired': return <ShieldAlert className="h-5 w-5 text-red-500" />;
      case 'missing_credential': return <FileWarning className="h-5 w-5 text-purple-500" />;
      case 'system': return <RefreshCcw className="h-5 w-5 text-blue-500" />;
      default: return <Bell className="h-5 w-5 text-primary" />;
    }
  };

  // Group notifications
  const grouped = notifications?.reduce((acc: any, notif) => {
    const date = new Date(notif.createdAt);
    let group = 'older';
    if (isToday(date)) group = 'today';
    else if (isYesterday(date)) group = 'yesterday';
    
    if (!acc[group]) acc[group] = [];
    acc[group].push(notif);
    return acc;
  }, { today: [], yesterday: [], older: [] });

  const hasUnread = notifications?.some(n => !n.isRead);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-primary/10 rounded-xl">
            <Bell className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('notifications.title')}</h1>
        </div>
        {hasUnread && (
          <Button onClick={handleMarkAllRead} variant="outline" className="min-h-11 w-full gap-2 sm:w-auto" disabled={markAllRead.isPending}>
            <Check className="h-4 w-4" />
            {t('notifications.mark_all_read')}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <Card key={i} className="animate-pulse h-24" />
          ))}
        </div>
      ) : !notifications?.length ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center border-dashed">
          <div className="h-16 w-16 bg-muted rounded-full flex items-center justify-center text-muted-foreground mb-4">
            <Bell className="h-8 w-8 opacity-50" />
          </div>
          <h3 className="text-lg font-semibold">{t('notifications.empty')}</h3>
        </Card>
      ) : (
        <div className="space-y-8">
          {(['today', 'yesterday', 'older'] as const).map(group => {
            const items = grouped[group];
            if (!items?.length) return null;

            return (
              <div key={group} className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider px-1">
                  {t(`notifications.${group}`)}
                </h3>
                <div className="space-y-3">
                  {items.map((notif: any) => (
                    <Card 
                      key={notif.id} 
                      className={cn(
                        "overflow-hidden border-s-4 transition-colors",
                        !notif.isRead ? "border-s-primary bg-muted/30" : "border-s-transparent bg-card"
                      )}
                    >
                      <CardContent className="flex gap-3 p-4 sm:gap-4 sm:p-5">
                        <div className="shrink-0 mt-1">
                          <div className={cn("p-2 rounded-full", !notif.isRead ? "bg-background shadow-sm" : "bg-muted/50")}>
                            {getIcon(notif.type)}
                          </div>
                        </div>
                        <div className="flex-1 space-y-1">
                          <div className="flex flex-col items-start gap-1 sm:flex-row sm:justify-between sm:gap-4">
                            <h4 className={cn("font-medium text-base", !notif.isRead && "text-foreground")}>
                              {language === 'en' ? notif.titleEn : notif.title}
                            </h4>
                            <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                              {format(new Date(notif.createdAt), "HH:mm")}
                            </span>
                          </div>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            {language === 'en' ? notif.messageEn : notif.message}
                          </p>
                          
                          {!notif.isRead && (
                            <div className="pt-2">
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="-ms-2 h-9 px-2 text-xs text-primary"
                                onClick={() => handleMarkRead(notif.id)}
                              >
                                {t('notifications.mark_read')}
                              </Button>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
