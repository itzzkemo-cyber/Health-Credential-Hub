/**
 * Bilingual (Arabic-first RTL + English) HTML email templates matching the
 * HealthDocs platform branding (teal primary, hsl(176 80% 27%) ≈ #0E7C75).
 * Inline styles only — email clients strip <style> blocks.
 */

import { getPublicAppUrl } from "../publicUrl";

const BRAND = {
  primary: "#0E7C75",
  primaryDark: "#0A5F5A",
  danger: "#dc2626",
  warning: "#d97706",
  bg: "#f1f5f9",
  text: "#1e293b",
  muted: "#64748b",
  border: "#e2e8f0",
};

export function getAppBaseUrl(): string | null {
  const appUrl = getPublicAppUrl();
  return appUrl ? `${appUrl}/` : null;
}

/**
 * Build a reset link whose bearer token is confined to the URL fragment.
 * Fragments never reach the HTTP server or intermediary request logs.
 */
export function getPasswordResetUrl(rawToken: string): string | null {
  const base = getAppBaseUrl();
  return base
    ? `${base}reset-password#token=${encodeURIComponent(rawToken)}`
    : null;
}

/**
 * Keep the invitation bearer token in the URL fragment. It is available to
 * the registration page but never sent in the initial HTTP request, proxy
 * access logs, or referrer query strings.
 */
export function getEmployeeInvitationUrl(rawToken: string): string | null {
  const base = getAppBaseUrl();
  return base ? `${base}register#token=${encodeURIComponent(rawToken)}` : null;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(bodyHtml: string): string {
  const appUrl = getAppBaseUrl();
  const cta = appUrl
    ? `<tr><td align="center" style="padding:8px 32px 28px;">
         <a href="${appUrl}" style="display:inline-block;background:${BRAND.primary};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 28px;border-radius:8px;font-size:15px;">
           فتح المنصة &nbsp;·&nbsp; Open HealthDocs
         </a>
       </td></tr>`
    : "";
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:Tahoma,'Segoe UI',Arial,sans-serif;color:${BRAND.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${BRAND.border};">
        <tr>
          <td style="background:${BRAND.primary};padding:20px 32px;" align="center">
            <div style="font-size:20px;font-weight:bold;color:#ffffff;">وثائقي الصحي</div>
            <div style="font-size:13px;color:#c7f0ec;letter-spacing:1px;">HEALTHDOCS</div>
          </td>
        </tr>
        ${bodyHtml}
        ${cta}
        <tr>
          <td style="padding:16px 32px;border-top:1px solid ${BRAND.border};" align="center">
            <div style="font-size:12px;color:${BRAND.muted};line-height:1.8;">
              هذه رسالة تلقائية من نظام وثائقي الصحي — لا حاجة للرد عليها.<br/>
              This is an automated message from HealthDocs — no reply is needed.
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export interface ExpiryEmailInput {
  titleAr: string;
  titleEn: string;
  messageAr: string;
  messageEn: string;
  expiryDate: string;
  daysUntilExpiry: number | null;
}

export function expiryAlertEmail(input: ExpiryEmailInput): string {
  const expired = input.daysUntilExpiry != null && input.daysUntilExpiry < 0;
  const urgent =
    !expired && input.daysUntilExpiry != null && input.daysUntilExpiry <= 7;
  const accent = expired
    ? BRAND.danger
    : urgent
      ? BRAND.warning
      : BRAND.primary;
  const badgeAr = expired
    ? "منتهية الصلاحية"
    : `متبقٍ ${input.daysUntilExpiry} يوم`;
  const badgeEn = expired ? "EXPIRED" : `${input.daysUntilExpiry} day(s) left`;

  const body = `
    <tr><td style="padding:28px 32px 8px;" dir="rtl" align="right">
      <span style="display:inline-block;background:${accent}1a;color:${accent};font-size:12px;font-weight:bold;padding:4px 12px;border-radius:999px;border:1px solid ${accent};">${esc(badgeAr)}</span>
      <h2 style="margin:14px 0 8px;font-size:18px;color:${BRAND.text};">${esc(input.titleAr)}</h2>
      <p style="margin:0;font-size:15px;line-height:1.9;">${esc(input.messageAr)}</p>
      ${input.expiryDate ? `<p style="margin:10px 0 0;font-size:14px;color:${BRAND.muted};">تاريخ انتهاء الصلاحية: <b style="color:${accent};" dir="ltr">${esc(input.expiryDate)}</b></p>` : ""}
    </td></tr>
    <tr><td style="padding:20px 32px;"><hr style="border:none;border-top:1px solid ${BRAND.border};margin:0;"/></td></tr>
    <tr><td style="padding:0 32px 20px;" dir="ltr" align="left">
      <span style="display:inline-block;background:${accent}1a;color:${accent};font-size:12px;font-weight:bold;padding:4px 12px;border-radius:999px;border:1px solid ${accent};">${esc(badgeEn)}</span>
      <h2 style="margin:14px 0 8px;font-size:18px;color:${BRAND.text};">${esc(input.titleEn)}</h2>
      <p style="margin:0;font-size:15px;line-height:1.7;">${esc(input.messageEn)}</p>
      ${input.expiryDate ? `<p style="margin:10px 0 0;font-size:14px;color:${BRAND.muted};">Expiry date: <b style="color:${accent};">${esc(input.expiryDate)}</b></p>` : ""}
    </td></tr>`;
  return layout(body);
}

export interface PasswordResetEmailInput {
  nameAr: string;
  name: string;
  resetUrl: string;
}

export function passwordResetEmail(input: PasswordResetEmailInput): string {
  const body = `
        <tr>
          <td style="padding:28px 32px 8px;" dir="rtl" align="right">
            <div style="font-size:17px;font-weight:bold;margin-bottom:8px;">مرحباً ${esc(input.nameAr)}،</div>
            <div style="font-size:14px;line-height:1.9;">
              وصلنا طلب لإعادة تعيين كلمة المرور لحسابك في منصة وثائقي الصحي.
              اضغط على الزر أدناه لاختيار كلمة مرور جديدة — الرابط صالح لمدة
              <strong>ساعة واحدة</strong> ولاستخدام واحد فقط.
            </div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 32px;">
            <a href="${esc(input.resetUrl)}" style="display:inline-block;background:${BRAND.primary};color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 32px;border-radius:8px;font-size:16px;">
              إعادة تعيين كلمة المرور &nbsp;·&nbsp; Reset Password
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 8px;" dir="rtl" align="right">
            <div style="font-size:13px;color:${BRAND.muted};line-height:1.9;">
              إن لم تطلب إعادة التعيين فتجاهل هذه الرسالة — كلمة مرورك الحالية لن تتغير.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 20px;border-top:1px dashed ${BRAND.border};" dir="ltr" align="left">
            <div style="font-size:13px;color:${BRAND.muted};line-height:1.8;">
              Hello ${esc(input.name)}, we received a request to reset your HealthDocs
              password. The button above opens a page to set a new one — the link is
              valid for <strong>1 hour</strong> and can be used once. If you didn't
              request this, simply ignore this email.
            </div>
          </td>
        </tr>`;
  return layout(body);
}

export interface EmployeeInvitationEmailInput {
  nameAr: string;
  name: string;
  invitationUrl: string;
}

export function employeeInvitationEmail(
  input: EmployeeInvitationEmailInput,
): string {
  const body = `
        <tr>
          <td style="padding:28px 32px 8px;" dir="rtl" align="right">
            <div style="font-size:17px;font-weight:bold;margin-bottom:8px;">مرحباً ${esc(input.nameAr)}،</div>
            <div style="font-size:14px;line-height:1.9;">
              أنشأ مسؤول منشأتك دعوة لك للانضمام إلى منصة وثائقي الصحي.
              استخدم الزر أدناه لإنشاء كلمة المرور وتفعيل حساب الموظف. الدعوة
              صالحة لمدة <strong>24 ساعة</strong> ولاستخدام واحد فقط.
            </div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 32px;">
            <a href="${esc(input.invitationUrl)}" style="display:inline-block;background:${BRAND.primary};color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 32px;border-radius:8px;font-size:16px;">
              تفعيل حساب الموظف &nbsp;·&nbsp; Activate employee account
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 8px;" dir="rtl" align="right">
            <div style="font-size:13px;color:${BRAND.muted};line-height:1.9;">
              إذا لم تكن تتوقع هذه الدعوة فتجاهل الرسالة وتواصل مع مسؤول منشأتك.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 20px;border-top:1px dashed ${BRAND.border};" dir="ltr" align="left">
            <div style="font-size:13px;color:${BRAND.muted};line-height:1.8;">
              Hello ${esc(input.name)}, an administrator at your facility invited
              you to HealthDocs. Use the button above to choose your password and
              activate your employee account. The invitation is valid for
              <strong>24 hours</strong> and can be used once. If you did not expect
              it, ignore this message and contact your facility administrator.
            </div>
          </td>
        </tr>`;
  return layout(body);
}

export interface EmployeeInvitationOtpEmailInput {
  nameAr: string;
  name: string;
  code: string;
  expiresMinutes: number;
}

/** The OTP is escaped and intentionally rendered as text, never as a link. */
export function employeeInvitationOtpEmail(
  input: EmployeeInvitationOtpEmailInput,
): string {
  const code = esc(input.code);
  const body = `
        <tr>
          <td style="padding:28px 32px 8px;" dir="rtl" align="right">
            <div style="font-size:17px;font-weight:bold;margin-bottom:8px;">مرحباً ${esc(input.nameAr)}،</div>
            <div style="font-size:14px;line-height:1.9;">
              استخدم رمز التحقق التالي لإكمال تفعيل حساب الموظف. الرمز صالح لمدة
              <strong>${input.expiresMinutes} دقائق</strong> ولاستخدام واحد فقط.
            </div>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 32px;">
            <div dir="ltr" style="display:inline-block;background:${BRAND.bg};color:${BRAND.primaryDark};border:1px solid ${BRAND.border};font-family:Consolas,monospace;font-size:30px;font-weight:bold;letter-spacing:8px;padding:14px 22px;border-radius:8px;">${code}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 8px;" dir="rtl" align="right">
            <div style="font-size:13px;color:${BRAND.muted};line-height:1.9;">
              لا تشارك هذا الرمز مع أي شخص. إذا لم تطلبه فتجاهل الرسالة وتواصل مع مسؤول منشأتك.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 32px 20px;border-top:1px dashed ${BRAND.border};" dir="ltr" align="left">
            <div style="font-size:13px;color:${BRAND.muted};line-height:1.8;">
              Hello ${esc(input.name)}, use the verification code above to finish
              activating your employee account. It expires in
              <strong>${input.expiresMinutes} minutes</strong> and can be used once.
              Never share this code. If you did not request it, ignore this email
              and contact your facility administrator.
            </div>
          </td>
        </tr>`;
  return layout(body);
}

export interface DigestMember {
  name: string;
  nameAr: string;
  expiredCount: number;
  expiringCount: number;
  missingCount: number;
}

export interface DigestEmailInput {
  managerName: string;
  managerNameAr: string;
  members: DigestMember[];
}

export function weeklyDigestEmail(input: DigestEmailInput): string {
  const rowsAr = input.members
    .map(
      (m) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;">${esc(m.nameAr)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;text-align:center;color:${m.expiredCount > 0 ? BRAND.danger : BRAND.muted};font-weight:${m.expiredCount > 0 ? "bold" : "normal"};">${m.expiredCount}</td>
        <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;text-align:center;color:${m.expiringCount > 0 ? BRAND.warning : BRAND.muted};font-weight:${m.expiringCount > 0 ? "bold" : "normal"};">${m.expiringCount}</td>
        <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;text-align:center;color:${m.missingCount > 0 ? BRAND.danger : BRAND.muted};font-weight:${m.missingCount > 0 ? "bold" : "normal"};">${m.missingCount}</td>
      </tr>`,
    )
    .join("");
  const rowsEn = input.members
    .map(
      (m) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;">${esc(m.name)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;text-align:center;">${m.expiredCount}</td>
        <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;text-align:center;">${m.expiringCount}</td>
        <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;text-align:center;">${m.missingCount}</td>
      </tr>`,
    )
    .join("");

  const th = `padding:8px 12px;background:${BRAND.bg};font-size:12px;color:${BRAND.muted};border-bottom:2px solid ${BRAND.border};`;
  const body = `
    <tr><td style="padding:28px 32px 8px;" dir="rtl" align="right">
      <h2 style="margin:0 0 8px;font-size:18px;">الملخص الأسبوعي لحالة وثائق فريقك</h2>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.9;">مرحباً ${esc(input.managerNameAr)}، لديك <b>${input.members.length}</b> من أعضاء فريقك بحاجة إلى متابعة هذا الأسبوع:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="border-collapse:collapse;">
        <tr>
          <th align="right" style="${th}">الموظف</th>
          <th style="${th}">منتهية</th>
          <th style="${th}">تنتهي قريباً</th>
          <th style="${th}">مفقودة</th>
        </tr>
        ${rowsAr}
      </table>
    </td></tr>
    <tr><td style="padding:20px 32px;"><hr style="border:none;border-top:1px solid ${BRAND.border};margin:0;"/></td></tr>
    <tr><td style="padding:0 32px 20px;" dir="ltr" align="left">
      <h2 style="margin:0 0 8px;font-size:18px;">Weekly team compliance digest</h2>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">Hello ${esc(input.managerName)}, <b>${input.members.length}</b> of your team members need attention this week:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <th align="left" style="${th}">Employee</th>
          <th style="${th}">Expired</th>
          <th style="${th}">Expiring</th>
          <th style="${th}">Missing</th>
        </tr>
        ${rowsEn}
      </table>
    </td></tr>`;
  return layout(body);
}
