import { Router, type IRouter } from "express";
import { db, facilitiesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getUser } from "../lib/auth";
import {
  getCredentialScopedUsers,
  getCredentialsFor,
  getPolicies,
  getDepartments,
  computeEmployeeStats,
} from "../lib/helpers";

const router: IRouter = Router();

router.use("/reports", requireAuth);

router.get("/reports/compliance", async (req, res) => {
  const user = getUser(req);
  const requestedFacilityId = req.query.facilityId
    ? Number(req.query.facilityId)
    : user.facilityId;
  const facilityId =
    user.role === "system_admin" && Number.isInteger(requestedFacilityId)
      ? requestedFacilityId
      : user.facilityId;
  const departmentId = req.query.departmentId
    ? Number(req.query.departmentId)
    : null;

  let scoped = (await getCredentialScopedUsers(user)).filter(
    (u) => u.isActive && u.facilityId === facilityId,
  );
  if (departmentId != null) {
    scoped = scoped.filter((u) => u.departmentId === departmentId);
  }
  const creds = await getCredentialsFor(scoped.map((u) => u.id));
  const policies = await getPolicies(facilityId);
  const departments = await getDepartments(facilityId);
  const facilityRows = await db
    .select()
    .from(facilitiesTable)
    .where(eq(facilitiesTable.id, facilityId));
  const facility = facilityRows[0];

  const deptIds = new Set(
    scoped.filter((u) => u.departmentId != null).map((u) => u.departmentId as number),
  );
  const visibleDepts = departments.filter((d) => deptIds.has(d.id));

  let overallSum = 0;
  let overallCount = 0;
  const deptReports = visibleDepts.map((d) => {
    const members = scoped.filter((u) => u.departmentId === d.id);
    let expiredCount = 0;
    let expiringCount = 0;
    let rateSum = 0;
    const employees = members.map((m) => {
      const s = computeEmployeeStats(m, creds, policies);
      expiredCount += s.expiredCount;
      expiringCount += s.expiringCount;
      rateSum += s.complianceRate;
      overallSum += s.complianceRate;
      overallCount += 1;
      return {
        name: m.name,
        nameAr: m.nameAr,
        employeeNumber: m.employeeNumber,
        complianceRate: s.complianceRate,
        expiredCount: s.expiredCount,
        expiringCount: s.expiringCount,
        missingCount: s.missingCount,
      };
    });
    employees.sort((a, b) => a.complianceRate - b.complianceRate);
    return {
      departmentName: d.name,
      employeeCount: members.length,
      complianceRate: members.length === 0 ? 100 : Math.round(rateSum / members.length),
      expiredCount,
      expiringCount,
      employees,
    };
  });
  deptReports.sort((a, b) => a.complianceRate - b.complianceRate);

  const report = {
    generatedAt: new Date().toISOString(),
    facilityName: facility?.name ?? "Facility",
    overallComplianceRate:
      overallCount === 0 ? 100 : Math.round(overallSum / overallCount),
    departments: deptReports,
  };

  if (req.query.format === "csv") {
    const csvCell = (value: string | number): string => {
      let text = String(value);
      if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [
      [
        "Department",
        "Employee Name",
        "Employee Number",
        "Compliance Rate",
        "Expired",
        "Expiring",
        "Missing",
      ],
      ...deptReports.flatMap((department) =>
        department.employees.map((employee) => [
          department.departmentName,
          employee.name,
          employee.employeeNumber,
          `${employee.complianceRate}%`,
          employee.expiredCount,
          employee.expiringCount,
          employee.missingCount,
        ]),
      ),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=compliance-report.csv");
    res.send(csv);
    return;
  }

  res.json(report);
});

export default router;
