import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { InvitationCard } from "./index";

const invitation = {
  id: 41,
  email: "noura@hospital.sa",
  name: "Noura Alqahtani",
  nameAr: "نورة القحطاني",
  role: "supervisor",
  jobTitle: "Charge nurse",
  jobTitleAr: "ممرضة مسؤولة",
  employeeNumber: "N-204",
  phone: null,
  facilityId: 3,
  departmentId: 4,
  supervisorId: null,
  expiresAt: "2026-09-02T12:00:00.000Z",
  createdAt: "2026-09-01T12:00:00.000Z",
} as const;

describe("employee invitation role UI", () => {
  it("shows the selected invitation role on the mobile-friendly card", () => {
    const html = renderToStaticMarkup(
      <InvitationCard
        invitation={invitation}
        isRTL={false}
        t={(key) =>
          ({
            "roles.supervisor": "Supervisor",
            "roles.employee": "Employee",
            "employees_page.employee_number": "Employee number",
            "employees_page.job_title": "Job title",
            "employees_page.invitation_expires": "Invitation expires",
            "employees_page.revoke_invitation": "Revoke invitation",
          })[key] ?? key
        }
        onRevoke={vi.fn()}
      />,
    );

    expect(html).toContain("Supervisor");
    expect(html).not.toContain(">Employee<");
    expect(html).toContain("min-[360px]:grid-cols-2");
  });

  it("keeps the selected role and employee identity localized in Arabic", () => {
    const html = renderToStaticMarkup(
      <InvitationCard
        invitation={invitation}
        isRTL
        t={(key) =>
          ({
            "roles.supervisor": "مشرف",
            "employees_page.employee_number": "الرقم الوظيفي",
            "employees_page.job_title": "المسمى الوظيفي",
            "employees_page.invitation_expires": "تنتهي صلاحية الدعوة",
            "employees_page.revoke_invitation": "إلغاء الدعوة",
          })[key] ?? key
        }
        onRevoke={vi.fn()}
      />,
    );

    expect(html).toContain("مشرف");
    expect(html).toContain("نورة القحطاني");
    expect(html).toContain("ممرضة مسؤولة");
  });
});
