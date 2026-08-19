import { useState } from "react";
import { FileText, Plus, QrCode, Search } from "lucide-react";
import { useListCredentials } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorState } from "@/components/QueryErrorState";
import { getAuthUser } from "@/lib/auth";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

export default function CredentialsList() {
  const { t, isRTL } = useLanguage();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const isEmployee = getAuthUser()?.role === "employee";

  const { data: response, error, isError, isLoading, refetch } =
    useListCredentials({
      search: search || undefined,
      pageSize: 50,
    });

  return (
    <div className="space-y-5 animate-in fade-in duration-500 md:space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">
            {isEmployee ? t("employee_portal.dashboard_eyebrow") : t("common.credentials")}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            {isEmployee ? t("employee_portal.my_documents") : t("common.credentials")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            {isEmployee
              ? t("employee_portal.my_documents_subtitle")
              : t("employee_portal.manage_documents_subtitle")}
          </p>
        </div>
        <Button
          onClick={() => setLocation("/credentials/new")}
          size="lg"
          className="min-h-12 w-full gap-2 sm:w-auto"
        >
          <Plus className="h-5 w-5" aria-hidden="true" />
          {t("employee_portal.upload_action")}
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
        <label htmlFor="credential-search" className="sr-only">
          {t("employee_portal.search_documents")}
        </label>
        <div className="relative w-full">
          <Search
            className={cn(
              "absolute top-3 h-4 w-4 text-muted-foreground",
              isRTL ? "right-3" : "left-3",
            )}
            aria-hidden="true"
          />
          <Input
            id="credential-search"
            placeholder={t("employee_portal.search_documents")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={cn("min-h-11 bg-background", isRTL ? "pr-9" : "pl-9")}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:gap-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-36 w-full rounded-xl sm:h-28" />
          ))
        ) : isError ? (
          <QueryErrorState error={error} onRetry={() => void refetch()} />
        ) : response?.data?.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center px-5 py-12 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <FileText className="h-8 w-8 text-primary" aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-lg font-semibold">
                {search
                  ? t("employee_portal.no_search_results")
                  : t("employee_portal.no_documents")}
              </h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                {search
                  ? t("employee_portal.try_another_search")
                  : t("employee_portal.no_documents_hint")}
              </p>
              {!search && (
                <Button
                  onClick={() => setLocation("/credentials/new")}
                  className="mt-5 min-h-11 w-full gap-2 sm:w-auto"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("employee_portal.upload_action")}
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          response?.data?.map((credential) => (
            <Card key={credential.id} className="overflow-hidden transition-shadow hover:shadow-md">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary sm:h-12 sm:w-12">
                    <FileText className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/credentials/${credential.id}`}
                        className="min-w-0 truncate text-base font-semibold transition-colors hover:text-primary sm:text-lg"
                      >
                        {isRTL
                          ? credential.customTypeNameAr || credential.type
                          : credential.customTypeName || credential.type}
                      </Link>
                      <Badge className={cn("shrink-0", getStatusColor(credential.status))} variant="outline">
                        {t(`common.${credential.status}`)}
                      </Badge>
                    </div>

                    <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                      <DocumentField
                        label={t("employee_portal.holder")}
                        value={isRTL
                          ? credential.holderNameAr || credential.holderName
                          : credential.holderName}
                      />
                      <DocumentField
                        label={t("employee_portal.issuer")}
                        value={isRTL
                          ? credential.issuerNameAr || credential.issuerName
                          : credential.issuerName}
                      />
                      <DocumentField
                        label={t("employee_portal.expires")}
                        value={new Date(credential.expiryDate).toLocaleDateString(
                          isRTL ? "ar-SA" : "en-US",
                        )}
                      />
                    </dl>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border pt-4 sm:flex sm:justify-end">
                  <Button asChild variant="outline" size="sm" className="min-h-11 gap-2">
                    <Link href={`/verify/${credential.qrToken}`}>
                      <QrCode className="h-4 w-4" aria-hidden="true" />
                      {t("employee_portal.verify")}
                    </Link>
                  </Button>
                  <Button asChild size="sm" className="min-h-11">
                    <Link href={`/credentials/${credential.id}`}>{t("common.view")}</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

function DocumentField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-foreground">{value}</dd>
    </div>
  );
}

function getStatusColor(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
    case "expiring_soon":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400";
    case "expired":
      return "bg-destructive/10 text-destructive dark:bg-destructive/20";
    default:
      return "bg-muted text-muted-foreground";
  }
}
