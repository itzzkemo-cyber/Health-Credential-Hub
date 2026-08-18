import { useState } from "react";
import { useLanguage } from "@/lib/language-context";
import { useListCredentials } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Search, Filter, MoreVertical, FileText, QrCode } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function CredentialsList() {
  const { t, isRTL } = useLanguage();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  const { data: response, isLoading } = useListCredentials({ 
    search: search || undefined,
    pageSize: 50 
  });

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'active': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400';
      case 'expiring_soon': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
      case 'expired': return 'bg-destructive/10 text-destructive dark:bg-destructive/20';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('common.credentials')}</h1>
          <p className="text-muted-foreground mt-1">Manage and verify professional certificates.</p>
        </div>
        <Button onClick={() => setLocation('/credentials/new')} className="gap-2">
          <Plus className="h-4 w-4" />
          {t('credential.add_new')}
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-center bg-card p-4 rounded-xl border border-border shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className={cn("absolute top-3 h-4 w-4 text-muted-foreground", isRTL ? "right-3" : "left-3")} />
          <Input
            placeholder={t('common.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cn("bg-background", isRTL ? "pr-9" : "pl-9")}
          />
        </div>
        <Button variant="outline" className="w-full sm:w-auto gap-2">
          <Filter className="h-4 w-4" />
          Filter
        </Button>
      </div>

      <div className="grid gap-4">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))
        ) : response?.data?.length === 0 ? (
          <div className="text-center py-12 bg-card rounded-xl border border-dashed">
            <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-20" />
            <h3 className="text-lg font-medium">No credentials found</h3>
            <p className="text-muted-foreground mt-1">Try adjusting your search or add a new one.</p>
          </div>
        ) : (
          response?.data?.map((cred) => (
            <Card key={cred.id} className="hover-elevate transition-all overflow-hidden group">
              <CardContent className="p-0">
                <div className="flex flex-col sm:flex-row items-center p-4 sm:p-5 gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FileText className="h-6 w-6" />
                  </div>
                  
                  <div className="flex-1 min-w-0 w-full text-center sm:text-start">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-1">
                      <Link href={`/credentials/${cred.id}`} className="font-semibold text-lg hover:text-primary transition-colors truncate">
                        {isRTL ? (cred.customTypeNameAr || cred.type) : (cred.customTypeName || cred.type)}
                      </Link>
                      <Badge className={cn("w-fit mx-auto sm:mx-0", getStatusColor(cred.status))} variant="outline">
                        {t(`common.${cred.status}`)}
                      </Badge>
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center text-sm text-muted-foreground gap-2 sm:gap-6">
                      <span className="truncate">Holder: <strong className="text-foreground font-medium">{isRTL ? cred.holderNameAr : cred.holderName}</strong></span>
                      <span className="truncate">Issuer: {isRTL ? cred.issuerNameAr : cred.issuerName}</span>
                      <span className="truncate">Exp: {new Date(cred.expiryDate).toLocaleDateString(isRTL ? 'ar-SA' : 'en-US')}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto justify-center sm:justify-end mt-4 sm:mt-0">
                    <Button variant="outline" size="sm" asChild className="gap-2">
                      <Link href={`/verify/${cred.qrToken}`}>
                        <QrCode className="h-4 w-4" />
                        Verify
                      </Link>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setLocation(`/credentials/${cred.id}`)}>
                          {t('common.view')}
                        </DropdownMenuItem>
                        <DropdownMenuItem>{t('common.edit')}</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive">{t('common.delete')}</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

function cn(...classes: (string | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
