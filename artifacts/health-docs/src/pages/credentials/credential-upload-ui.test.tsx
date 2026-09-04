import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { UPLOAD_ACCEPT_ATTRIBUTE } from "@/lib/upload";
import { DocumentPicker } from "./new";

const translations: Record<string, string> = {
  "credential.uploading_title": "Uploading document…",
  "credential.uploading_hint": "Keep this page open",
  "credential.file_ready": "Selected locally",
  "credential.manual_upload_hint": "JPG, PNG or PDF",
  "credential.remove_file": "Remove File",
  "credential.replace_file": "Replace File",
  "credential.choose_file": "Choose File",
};

const t = (key: string) => translations[key] ?? key;

describe("responsive credential document picker", () => {
  it("advertises PDF and keeps actions full-width at 390px before widening", () => {
    const html = renderToStaticMarkup(
      <DocumentPicker
        id="employee-document"
        busy={false}
        fileName="شهادة-مهنية-طويلة-الاسم.pdf"
        compact
        onChange={vi.fn()}
        onClear={vi.fn()}
        t={t}
      />,
    );

    expect(html).toContain(`accept="${UPLOAD_ACCEPT_ATTRIBUTE}"`);
    expect(html).toContain("flex-wrap items-center sm:flex-nowrap");
    expect(html).toContain("w-full sm:flex sm:w-auto");
    expect(html).toContain("truncate");
    expect(html).toContain('dir="auto"');
  });

  it("announces local PDF validation without showing upload progress", () => {
    const html = renderToStaticMarkup(
      <DocumentPicker
        id="employee-document"
        busy
        busyTitle="جارٍ فحص ملف PDF…"
        busyHint="يتم التحقق من الحجم وعدد الصفحات على جهازك قبل الرفع."
        fileName=""
        compact
        onChange={vi.fn()}
        onClear={vi.fn()}
        t={t}
      />,
    );

    expect(html).toContain("جارٍ فحص ملف PDF…");
    expect(html).toContain("يتم التحقق من الحجم وعدد الصفحات");
    expect(html).not.toContain("Uploading document…");
  });
});
