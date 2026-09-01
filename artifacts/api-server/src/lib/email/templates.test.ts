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
