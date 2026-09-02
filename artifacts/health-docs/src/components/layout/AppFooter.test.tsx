import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  getLanguageDirection,
  LanguageContext,
  type Language,
} from "@/lib/language-context";
import { ar } from "@/lib/locales/ar";
import { en } from "@/lib/locales/en";
import { AppFooter, DEVELOPER_NAME } from "./AppFooter";
import { PublicPageLayout } from "./PublicPageLayout";

type TranslationDictionary = typeof ar | typeof en;

function translation(language: Language, key: string): string {
  const dictionary: TranslationDictionary = language === "ar" ? ar : en;
  let value: unknown = dictionary;

  for (const segment of key.split(".")) {
    if (typeof value !== "object" || value === null || !(segment in value)) {
      return key;
    }
    value = (value as Record<string, unknown>)[segment];
  }

  return typeof value === "string" ? value : key;
}

function renderWithLanguage(page: React.ReactElement, language: Language) {
  return renderToStaticMarkup(
    <LanguageContext.Provider
      value={{
        language,
        setLanguage: vi.fn(),
        t: (key) => translation(language, key),
        isRTL: getLanguageDirection(language) === "rtl",
      }}
    >
      {page}
    </LanguageContext.Provider>,
  );
}

describe("shared application footer", () => {
  it.each(["ar", "en"] as const)(
    "renders localized semantic credit in %s",
    (language) => {
      const html = renderWithLanguage(<AppFooter />, language).replaceAll(
        "&#x27;",
        "'",
      );

      expect(html.match(/<footer/g)).toHaveLength(1);
      expect(html).toContain(translation(language, "footer.aria_label"));
      expect(html).toContain(translation(language, "footer.powered_by"));
      expect(html).toContain(translation(language, "footer.developed_by"));
      expect(html).toContain(DEVELOPER_NAME);
      expect(html).toContain('<bdi lang="en" dir="ltr"');
    },
  );

  it("gives public pages one footer after their content", () => {
    const html = renderWithLanguage(
      <PublicPageLayout>
        <main>Public page</main>
      </PublicPageLayout>,
      "ar",
    );

    expect(html.indexOf("Public page")).toBeLessThan(html.indexOf("<footer"));
    expect(html.match(/<footer/g)).toHaveLength(1);
  });
});
