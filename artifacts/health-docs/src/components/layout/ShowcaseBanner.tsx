import { FlaskConical, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isShowcaseMode, resetShowcase } from "@/demo/showcase";
import { useLanguage } from "@/lib/language-context";

export function ShowcaseBanner({ compact = false }: { compact?: boolean }) {
  const { t } = useLanguage();
  if (!isShowcaseMode) return null;

  return (
    <aside
      className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100 sm:text-sm"
      aria-label={t("showcase.label")}
    >
      <FlaskConical className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className={compact ? "line-clamp-2" : "font-medium"}>
        {t("showcase.notice")}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={resetShowcase}
        aria-label={t("showcase.reset")}
        className="ms-1 min-h-9 shrink-0 gap-1 px-2 text-amber-950 hover:bg-amber-100 hover:text-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">{t("showcase.reset")}</span>
      </Button>
    </aside>
  );
}
