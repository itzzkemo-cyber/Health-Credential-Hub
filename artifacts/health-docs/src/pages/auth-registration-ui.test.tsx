import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getLanguageDirection,
  LanguageContext,
  type Language,
} from "@/lib/language-context";
import { ar } from "@/lib/locales/ar";
import { en } from "@/lib/locales/en";
import Login from "./login";
import Register from "./register";

vi.mock("@workspace/api-client-react", () => ({
  ApiError: class ApiError extends Error {
    data: unknown = null;
  },
  useAcceptEmployeeInvitation: () => ({
    isPending: false,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
  useStartInvitationEmailVerification: () => ({
    isPending: false,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
  useLogin: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("wouter", async () => {
  const ReactModule = await import("react");
  const Link = ReactModule.forwardRef<
    HTMLAnchorElement,
    React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
  >(({ href, children, ...props }, ref) =>
    ReactModule.createElement("a", { ...props, href, ref }, children),
  );
  Link.displayName = "TestLink";

  return {
    Link,
    useLocation: () => ["/login", vi.fn()],
  };
});

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

function renderWithLanguage(
  page: React.ReactElement,
  language: Language,
): string {
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

function renderRegister(language: Language, href: string) {
  const state = { route: "register" };
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { href, pathname: "/register" },
    history: { state, replaceState },
  });

  return {
    html: renderWithLanguage(<Register />, language),
    replaceState,
    state,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invite-only authentication UI", () => {
  it.each([
    ["ar", "rtl"],
    ["en", "ltr"],
  ] as const)(
    "fails closed without an invitation in %s/%s",
    (language, direction) => {
      const { html, replaceState, state } = renderRegister(
        language,
        "https://app.example.sa/register",
      );

      expect(getLanguageDirection(language)).toBe(direction);
      expect(html).toContain(
        translation(language, "register.invitation_required_title"),
      );
      expect(html).toContain(
        translation(language, "register.no_invitation_hint"),
      );
      expect(html).toContain('href="/login"');
      expect(html).not.toContain("<form");
      expect(html).not.toContain('id="registration-password"');
      expect(replaceState).toHaveBeenCalledWith(state, "", "/register");
    },
  );

  it.each(["ar", "en"] as const)(
    "renders the work-email verification step in %s without exposing its token",
    (language) => {
      const invitationToken = "single-use-sensitive-token";
      const { html } = renderRegister(
        language,
        `https://app.example.sa/register#token=${invitationToken}`,
      );

      expect(html).toContain(translation(language, "register.email_title"));
      expect(html).toContain(translation(language, "register.email_subtitle"));
      expect(html).toContain(translation(language, "register.email_hint"));
      expect(html).toContain(
        translation(language, "register.invitation_required"),
      );
      expect(html).toContain("<form");
      expect(html).toContain('id="registration-email-hint"');
      expect(html).not.toContain('type="tel"');
      expect(html).not.toContain('autocomplete="tel-national"');
      expect(html).not.toContain('id="registration-password"');
      expect(html).not.toContain(invitationToken);
    },
  );

  it.each(["ar", "en"] as const)(
    "keeps the login-to-invitation handoff localized in %s",
    (language) => {
      const html = renderWithLanguage(<Login />, language);

      expect(html).toContain(translation(language, "auth.login"));
      expect(html).toContain(
        translation(language, "auth.employee_registration_hint"),
      );
      expect(html).toContain(
        translation(language, "auth.employee_registration"),
      );
      expect(html).toContain('href="/register"');
      expect(html).toContain('autoComplete="username"');
      expect(html.match(/dir="ltr"/g)).toHaveLength(2);
    },
  );

  it.each(["ar", "en"] as const)(
    "provides complete localized registration and employee-invitation feedback in %s",
    (language) => {
      const keys = [
        "register.weak_password",
        "register.mismatch",
        "register.invalid_title",
        "register.invalid_hint",
        "register.failed",
        "register.email_hint",
        "register.code_entered_pending_verification",
        "register.email_verification_failed",
        "register.invalid_email_otp",
        "register.otp_rate_limited",
        "register.otp_delivery_failed",
        "register.otp_unavailable",
        "register.otp_verification_in_progress",
        "register.send_code",
        "register.code",
        "register.resend_code",
        "register.success_title",
        "register.success_message",
        "employees_page.invitation_employee_role_hint",
        "employees_page.create_step_up_hint",
        "employees_page.invitation_step_up_hint",
        "employees_page.invitation_email_hint",
        "employees_page.invitation_failed",
      ];

      for (const key of keys) {
        const localized = translation(language, key);
        expect(localized).not.toBe(key);
        expect(localized.trim().length).toBeGreaterThan(0);
      }
    },
  );

  it("states that a locally complete code is still pending server verification", () => {
    expect(en.register.code_entered_pending_verification).toContain(
      "not been verified yet",
    );
    expect(ar.register.code_entered_pending_verification).toContain(
      "لم يُتحقق منه بعد",
    );
  });
});
