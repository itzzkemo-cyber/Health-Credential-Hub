import { useState } from "react";
import { useListAuditLogs } from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language-context";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Search, Activity, User, ShieldAlert, Monitor, ArrowLeftRight } from "lucide-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";

export default function AuditLog() {
  const { t } = useLanguage();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const { data: logData, isLoading } = useListAuditLogs({
    page,
    pageSize: 50,
    action: actionFilter !== "all" ? actionFilter : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined
  });

  const getActionBadge = (action: string) => {
    if (action.includes("CREATE")) return <Badge variant="default" className="bg-emerald-500/10 text-emerald-700 border-emerald-200">{action}</Badge>;
    if (action.includes("UPDATE")) return <Badge variant="default" className="bg-blue-500/10 text-blue-700 border-blue-200">{action}</Badge>;
    if (action.includes("DELETE")) return <Badge variant="destructive" className="bg-red-500/10 text-red-700 border-red-200">{action}</Badge>;
    if (action.includes("LOGIN")) return <Badge variant="secondary">{action}</Badge>;
    return <Badge variant="outline">{action}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('audit_log.title')}</h1>
          <p className="text-muted-foreground">{t('audit_log.subtitle')}</p>
        </div>
      </div>

      <Card className="border-border/50 shadow-sm">
        <div className="p-4 border-b flex flex-col sm:flex-row gap-4 bg-muted/20">
          <div className="w-full sm:w-[250px]">
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger>
                <SelectValue placeholder={t('audit_log.filter_action')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('common.all')}</SelectItem>
                <SelectItem value="CREDENTIAL_CREATE">CREDENTIAL_CREATE</SelectItem>
                <SelectItem value="CREDENTIAL_UPDATE">CREDENTIAL_UPDATE</SelectItem>
                <SelectItem value="CREDENTIAL_DELETE">CREDENTIAL_DELETE</SelectItem>
                <SelectItem value="USER_LOGIN">USER_LOGIN</SelectItem>
                <SelectItem value="POLICY_UPDATE">POLICY_UPDATE</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 w-full sm:w-auto">
            <Input 
              type="date" 
              value={dateFrom} 
              onChange={(e) => setDateFrom(e.target.value)} 
              className="w-full sm:w-auto"
            />
            <Input 
              type="date" 
              value={dateTo} 
              onChange={(e) => setDateTo(e.target.value)} 
              className="w-full sm:w-auto"
            />
          </div>
        </div>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground animate-pulse">
              {t('common.loading')}
            </div>
          ) : !logData?.data?.length ? (
            <div className="p-12 text-center flex flex-col items-center">
              <FileText className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <p className="text-lg font-medium">{t('audit_log.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="w-[180px]">{t('audit_log.time')}</TableHead>
                  <TableHead>{t('audit_log.user')}</TableHead>
                  <TableHead>{t('audit_log.action')}</TableHead>
                  <TableHead>{t('audit_log.target')}</TableHead>
                  <TableHead className="text-right">{t('audit_log.ip')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logData.data.map((log: any) => (
                  <TableRow key={log.id} className="hover:bg-muted/30">
                    <TableCell className="font-medium text-muted-foreground whitespace-nowrap">
                      {format(new Date(log.createdAt), "yyyy-MM-dd HH:mm:ss")}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
                          <User className="h-3 w-3 text-primary" />
                        </div>
                        <span className="font-medium text-sm">{log.userName || `User #${log.userId}`}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {getActionBadge(log.action)}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-mono text-muted-foreground bg-muted px-2 py-1 rounded-md inline-block">
                        {log.entityType} #{log.entityId}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-sm font-mono dir-ltr">
                      {log.ipAddress || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
