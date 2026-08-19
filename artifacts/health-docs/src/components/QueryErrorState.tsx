import { ApiError } from "@workspace/api-client-react";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { Link } from "wouter";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLanguage } from "@/lib/language-context";

export function QueryErrorState({
  error,
  onRetry,
  compact = false,
}: {
  error?: unknown;
  onRetry: () => void;
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const isForbidden = error instanceof ApiError && error.status === 403;

  return (
    <Card
      className={
        compact
          ? "border-destructive/30"
          : "mx-auto max-w-lg border-destructive/30"
      }
    >
      <CardContent
        className={
          compact
            ? "flex flex-col items-start gap-3 p-4"
            : "flex flex-col items-center gap-4 p-8 text-center"
        }
        role="alert"
        aria-live="assertive"
      >
        <ShieldAlert className="h-9 w-9 text-destructive" aria-hidden="true" />
        <div className={compact ? "space-y-1" : "space-y-2"}>
          <h3 className="font-semibold">
            {t(
              isForbidden
                ? "common.forbidden_title"
                : "common.load_error_title",
            )}
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {t(
              isForbidden
                ? "common.forbidden_description"
                : "common.load_error_description",
            )}
          </p>
        </div>
        {isForbidden ? (
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/">{t("common.go_home")}</Link>
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={onRetry}
            className="min-h-11 gap-2"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t("common.retry")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
