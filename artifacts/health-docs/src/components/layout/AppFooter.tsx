import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

export const DEVELOPER_NAME = "ABDULKARIM ALHEJAILI";

export function AppFooter({ className }: { className?: string }) {
  const { t } = useLanguage();

  return (
    <footer
      aria-label={t("footer.aria_label")}
      className={cn(
        "shrink-0 space-y-1 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6 text-center text-xs leading-5 text-muted-foreground",
        className,
      )}
    >
      <p>
        {t("footer.powered_by")} &copy; {new Date().getFullYear()}
      </p>
      <p>
        {t("footer.developed_by")} {" "}
        <bdi lang="en" dir="ltr" className="font-semibold text-foreground/80">
          {DEVELOPER_NAME}
        </bdi>
      </p>
    </footer>
  );
}
