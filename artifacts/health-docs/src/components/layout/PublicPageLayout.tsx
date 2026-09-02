import type { ReactNode } from "react";

import { AppFooter } from "./AppFooter";

export function PublicPageLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <AppFooter />
    </div>
  );
}
