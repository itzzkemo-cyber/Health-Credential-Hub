import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageContext, type Language } from "@/lib/language-context";
import { ar } from "@/lib/locales/ar";
import { en } from "@/lib/locales/en";
import { MobileBottomNav } from "./MobileBottomNav";

const state = vi.hoisted(() => ({ role: "employee" }));

vi.mock("@/lib/auth", () => ({
  getAuthUser: () => ({ role: state.role }),
}));

function translate(language: Language, key: string): string {
  let current: unknown = language === "ar" ? ar : en;
  for (const segment of key.split("."))
    current =
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined;
  return typeof current === "string" ? current : key;
}

function render(path: string, language: Language = "ar") {
  return renderToStaticMarkup(
    <LanguageContext.Provider
      value={{
        language,
        setLanguage: vi.fn(),
        t: (key) => translate(language, key),
        isRTL: language === "ar",
      }}
    >
      <Router ssrPath={path}>
        <MobileBottomNav />
      </Router>
    </LanguageContext.Provider>,
  );
}

beforeEach(() => {
  state.role = "employee";
});

describe("employee mobile navigation", () => {
  it.each(["ar", "en"] as const)(
    "keeps the %s schedule as a permanent mobile tab",
    (language) => {
      const html = render("/schedules", language);

      expect(html).toContain('href="/schedules"');
      expect(html).toContain(translate(language, "mobile.schedule"));
      expect(html).toContain('aria-current="page"');
      expect(html).not.toContain('href="/notifications"');
    },
  );

  it.each([
    "supervisor",
    "department_manager",
    "hospital_admin",
    "system_admin",
  ])("keeps the bottom bar hidden for management role %s", (role) => {
    state.role = role;
    expect(render("/schedules")).toBe("");
  });
});
