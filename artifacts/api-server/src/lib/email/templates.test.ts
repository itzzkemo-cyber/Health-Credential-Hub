import { afterEach, describe, expect, it } from "vitest";
import {
  employeeInvitationEmail,
  employeeInvitationText,
  getEmployeeInvitationUrl,
  getPasswordResetUrl,
  passwordResetEmail,
} from "./templates";

const originalNodeEnv = process.env.NODE_ENV;
const originalPublicAppUrl = process.env.PUBLIC_APP_URL;

afterEach(() => {
  for (const [name, value] of [
    ["NODE_ENV", originalNodeEnv],
    ["PUBLIC_APP_URL", originalPublicAppUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("password reset links", () => {
  it("keeps the bearer token out of the HTTP query string", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "https://credentials.example.sa";

    const resetUrl = getPasswordResetUrl("secret token");

    expect(resetUrl).toBe(
      "https://credentials.example.sa/reset-password#token=secret%20token",
    );
    const parsed = new URL(resetUrl!);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("#token=secret%20token");
  });

  it("keeps reset links in a tappable CTA without exposing a visible token", () => {
    const resetUrl =
      "https://credentials.example.sa/reset-password#token=private-token";
    const html = passwordResetEmail({
      name: "Employee",
      nameAr: "موظف",
      resetUrl,
    });

    expect(html).toContain(`href="${resetUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html.split(resetUrl)).toHaveLength(2);
    expect(html).not.toContain("copy this private link");
  });
});

describe("employee invitation links", () => {
  it("keeps the bearer token out of the HTTP query string", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_APP_URL = "https://credentials.example.sa";

    const invitationUrl = getEmployeeInvitationUrl("secret token");

    expect(invitationUrl).toBe(
      "https://credentials.example.sa/register#token=secret%20token",
    );
    const parsed = new URL(invitationUrl!);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("#token=secret%20token");
  });

  it("escapes authoritative profile text in the bilingual HTML", () => {
    const invitationUrl = "https://credentials.example.sa/register#token=safe";
    const html = employeeInvitationEmail({
      name: '<script>alert("x")</script>',
      nameAr: "<b>موظف</b>",
      invitationUrl,
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>موظف</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;موظف&lt;/b&gt;");
    expect(html).toContain("24 ساعة");
    expect(html).toContain("24 hours");
  });

  it("renders a Gmail-friendly button and a copyable fallback link", () => {
    const invitationUrl =
      "https://credentials.example.sa/register#token=one-time-token";
    const html = employeeInvitationEmail({
      name: "Employee",
      nameAr: "موظف",
      invitationUrl,
    });

    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain(`href="${invitationUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('role="presentation"');
    expect(html).toContain("إذا لم يعمل الزر");
    expect(html).toContain("copy this private link");
    // CTA href, fallback href, and the visible copyable URL.
    expect(html.split(invitationUrl)).toHaveLength(4);
  });

  it("keeps bold Arabic runs out of the Outlook invitation markup", () => {
    const html = employeeInvitationEmail({
      name: "Abdulkarim",
      nameAr: "عبدالكريم",
      invitationUrl:
        "https://credentials.example.sa/register#token=one-time-token",
    });

    const arabicRuns = [
      ...html.matchAll(
        /<(?:div|span)[^>]*lang="ar"[^>]*style="([^"]*)"[^>]*>([^<]*)/g,
      ),
    ];

    expect(arabicRuns.length).toBeGreaterThanOrEqual(4);
    for (const [, style] of arabicRuns) {
      expect(style).toContain("font-family:Arial,Tahoma,'Segoe UI',sans-serif");
      expect(style).toContain("mso-bidi-font-family:Arial");
      expect(style).not.toMatch(/font-weight:(?:bold|[6-9]00)/);
    }
    expect(html).not.toContain("<strong>24 ساعة</strong>");
  });

  it("isolates Arabic and English CTA labels for Outlook direction handling", () => {
    const html = employeeInvitationEmail({
      name: "Employee",
      nameAr: "موظف",
      invitationUrl:
        "https://credentials.example.sa/register#token=one-time-token",
    });

    expect(html).toContain(
      '<span lang="ar" dir="rtl" style="display:block;color:#ffffff;font-family:Arial,Tahoma,\'Segoe UI\',sans-serif;mso-bidi-font-family:Arial;font-weight:400;">تفعيل حساب الموظف</span>',
    );
    expect(html).toContain(
      '<span lang="en" dir="ltr" style="display:block;color:#ffffff;font-family:Arial,\'Segoe UI\',Tahoma,sans-serif;font-weight:700;">Activate employee account</span>',
    );
    expect(html).not.toContain(
      "تفعيل حساب الموظف &nbsp;·&nbsp; Activate employee account",
    );
  });

  it("provides a plain-text alternative with the same private link", () => {
    const invitationUrl =
      "https://credentials.example.sa/register#token=one-time-token";
    const text = employeeInvitationText({
      name: "Employee",
      nameAr: "موظف",
      invitationUrl,
    });

    expect(text).toContain(invitationUrl);
    expect(text).toContain("24 ساعة");
    expect(text).toContain("24 hours");
    expect(text).toContain("لا تشاركه");
    expect(text).toContain("Do not share");
  });
});
