import type { ReactNode, SelectHTMLAttributes } from "react";
import { CalendarDays, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

export function NativeSelect({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    />
  );
}

export function MonthPicker({
  month,
  onChange,
  disabled = false,
}: {
  month: string;
  onChange: (month: string) => void;
  disabled?: boolean;
}) {
  const { t } = useLanguage();
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      <span>{t("schedules.month")}</span>
      <Input
        aria-label={t("schedules.month")}
        type="month"
        dir="ltr"
        min="2000-01"
        max="2099-12"
        value={month}
        disabled={disabled}
        className="min-h-11 w-full sm:w-48"
        onChange={(event) => {
          if (/^20\d{2}-(0[1-9]|1[0-2])$/.test(event.target.value))
            onChange(event.target.value);
        }}
      />
    </label>
  );
}

export function ScheduleLoading() {
  const { t } = useLanguage();
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-3 py-16 text-muted-foreground"
    >
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      {t("common.loading")}
    </div>
  );
}

export function ScheduleEmpty({
  employee = false,
  team = false,
  children,
}: {
  employee?: boolean;
  team?: boolean;
  children?: ReactNode;
}) {
  const { t } = useLanguage();
  const key = team ? "team_empty" : employee ? "my_empty" : "empty";
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-8 text-center">
      <CalendarDays className="h-10 w-10 text-primary/60" aria-hidden="true" />
      <h2 className="font-semibold">{t(`schedules.${key}`)}</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {t(`schedules.${key}_hint`)}
      </p>
      {children}
    </div>
  );
}
