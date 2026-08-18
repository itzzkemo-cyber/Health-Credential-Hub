/* Seed script: creates a realistic demo dataset for HealthDocs.
 * Run: node /tmp/seed.cjs (bundled via esbuild) — see package.json "seed" script.
 */
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  facilitiesTable,
  departmentsTable,
  usersTable,
  credentialsTable,
  notificationsTable,
  auditLogsTable,
  credentialPoliciesTable,
  type CredentialType,
  type User,
} from "@workspace/db";

function d(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
function qr(): string {
  return crypto.randomBytes(16).toString("hex");
}
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

async function main() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_DEMO_SEED !== "true"
  ) {
    throw new Error(
      "Demo seed is destructive and requires ALLOW_DEMO_SEED=true outside production",
    );
  }
  console.log("Clearing existing data…");
  await db.delete(auditLogsTable);
  await db.delete(notificationsTable);
  await db.delete(credentialsTable);
  await db.delete(credentialPoliciesTable);
  await db.delete(usersTable);
  await db.delete(departmentsTable);
  await db.delete(facilitiesTable);

  console.log("Creating facility…");
  const [facility] = await db
    .insert(facilitiesTable)
    .values({
      name: "King Fahad Specialist Hospital",
      nameAr: "مستشفى الملك فهد التخصصي",
    })
    .returning();
  if (!facility) throw new Error("facility insert failed");

  console.log("Creating departments…");
  const deptRows = await db
    .insert(departmentsTable)
    .values([
      { name: "Emergency", nameAr: "قسم الطوارئ", facilityId: facility.id },
      { name: "Intensive Care", nameAr: "العناية المركزة", facilityId: facility.id },
      { name: "Nursing", nameAr: "قسم التمريض", facilityId: facility.id },
      { name: "Laboratory", nameAr: "المختبر", facilityId: facility.id },
    ])
    .returning();
  const [er, icu, nursing, lab] = deptRows;
  if (!er || !icu || !nursing || !lab) throw new Error("departments insert failed");

  console.log("Creating users…");
  const hash = await bcrypt.hash("demo1234", 10);
  const mk = (
    email: string,
    name: string,
    nameAr: string,
    role: User["role"],
    departmentId: number | null,
    jobTitle: string,
    jobTitleAr: string,
    employeeNumber: string,
    phone?: string,
  ) => ({
    email,
    passwordHash: hash,
    name,
    nameAr,
    role,
    departmentId,
    supervisorId: null as number | null,
    facilityId: facility.id,
    jobTitle,
    jobTitleAr,
    employeeNumber,
    phone: phone ?? null,
    isActive: true,
  });

  const [admin] = await db.insert(usersTable).values(
    mk("admin@healthdocs.sa", "Ahmed Alghamdi", "أحمد الغامدي", "system_admin", null, "IT Director", "مدير تقنية المعلومات", "EMP-0001", "+966501111111"),
  ).returning();
  const [hospital] = await db.insert(usersTable).values(
    mk("hospital@healthdocs.sa", "Dr. Khalid Alotaibi", "د. خالد العتيبي", "hospital_admin", null, "Hospital Director", "مدير المستشفى", "EMP-0002", "+966502222222"),
  ).returning();
  const [deptMgr] = await db.insert(usersTable).values(
    mk("dept@healthdocs.sa", "Dr. Muna Alqahtani", "د. منى القحطاني", "department_manager", icu.id, "ICU Department Manager", "مديرة قسم العناية المركزة", "EMP-0003", "+966503333333"),
  ).returning();
  const [supervisor] = await db.insert(usersTable).values(
    mk("supervisor@healthdocs.sa", "Sara Alzahrani", "سارة الزهراني", "supervisor", nursing.id, "Nursing Supervisor", "مشرفة التمريض", "EMP-0004", "+966504444444"),
  ).returning();
  if (!admin || !hospital || !deptMgr || !supervisor) throw new Error("core users failed");

  const staffValues = [
    mk("employee@healthdocs.sa", "Noura Alshammari", "نورة الشمري", "employee", nursing.id, "Registered Nurse", "ممرضة قانونية", "EMP-0005", "+966505555555"),
    mk("fatimah@healthdocs.sa", "Fatimah Hassan", "فاطمة حسن", "employee", nursing.id, "Staff Nurse", "ممرضة", "EMP-0006"),
    mk("mohammed@healthdocs.sa", "Mohammed Alharbi", "محمد الحربي", "employee", nursing.id, "Charge Nurse", "ممرض مسؤول", "EMP-0007"),
    mk("aisha@healthdocs.sa", "Aisha Almutairi", "عائشة المطيري", "employee", icu.id, "ICU Nurse", "ممرضة عناية مركزة", "EMP-0008"),
    mk("omar@healthdocs.sa", "Omar Aldossari", "عمر الدوسري", "employee", icu.id, "Respiratory Therapist", "أخصائي علاج تنفسي", "EMP-0009"),
    mk("layla@healthdocs.sa", "Layla Alamri", "ليلى العمري", "employee", er.id, "ER Nurse", "ممرضة طوارئ", "EMP-0010"),
    mk("yousef@healthdocs.sa", "Yousef Alshehri", "يوسف الشهري", "employee", er.id, "Paramedic", "مسعف", "EMP-0011"),
    mk("huda@healthdocs.sa", "Huda Alsubaie", "هدى السبيعي", "employee", lab.id, "Lab Technician", "فنية مختبر", "EMP-0012"),
  ];
  const staff = await db.insert(usersTable).values(staffValues).returning();
  const [noura, fatimah, mohammed, aisha, omar, layla, yousef, huda] = staff;
  if (!noura || !fatimah || !mohammed || !aisha || !omar || !layla || !yousef || !huda)
    throw new Error("staff insert failed");

  // Supervisor links: nursing staff report to Sara
  await db.update(usersTable).set({ supervisorId: supervisor.id })
    .where(eq(usersTable.id, noura.id));
  await db.update(usersTable).set({ supervisorId: supervisor.id })
    .where(eq(usersTable.id, fatimah.id));
  await db.update(usersTable).set({ supervisorId: supervisor.id })
    .where(eq(usersTable.id, mohammed.id));
  // Department heads
  await db.update(departmentsTable).set({ headId: deptMgr.id }).where(eq(departmentsTable.id, icu.id));
  await db.update(departmentsTable).set({ headId: supervisor.id }).where(eq(departmentsTable.id, nursing.id));

  console.log("Creating policies…");
  await db.insert(credentialPoliciesTable).values([
    { facilityId: facility.id, credentialType: "BLS", roles: [], departmentId: null, isRequired: true },
    { facilityId: facility.id, credentialType: "infection_control", roles: [], departmentId: null, isRequired: true },
    { facilityId: facility.id, credentialType: "fire_safety", roles: [], departmentId: null, isRequired: true },
    { facilityId: facility.id, credentialType: "SCFHS_license", roles: ["employee", "supervisor", "department_manager"], departmentId: null, isRequired: true },
    { facilityId: facility.id, credentialType: "ACLS", roles: [], departmentId: icu.id, isRequired: true },
    { facilityId: facility.id, credentialType: "iqama", roles: [], departmentId: null, isRequired: true },
  ]);

  console.log("Creating credentials…");
  const AHA = { en: "American Heart Association", ar: "جمعية القلب الأمريكية" };
  const SCFHS = { en: "Saudi Commission for Health Specialties", ar: "الهيئة السعودية للتخصصات الصحية" };
  const MOH = { en: "Ministry of Health", ar: "وزارة الصحة" };
  const MOI = { en: "Ministry of Interior", ar: "وزارة الداخلية" };
  const CD = { en: "Civil Defense", ar: "الدفاع المدني" };

  type CredSpec = {
    u: User;
    type: CredentialType;
    issuer: { en: string; ar: string };
    cert: string;
    issued: string;
    expiry: string;
    verified?: boolean;
    tags?: string[];
    notes?: string;
  };
  const specs: CredSpec[] = [
    // Noura (demo employee) — mixed statuses
    { u: noura, type: "BLS", issuer: AHA, cert: "AHA-2025-73641", issued: d(-200), expiry: d(530), verified: true, tags: ["تدريب", "إنعاش"] },
    { u: noura, type: "ACLS", issuer: AHA, cert: "AHA-2024-51298", issued: d(-700), expiry: d(30), verified: true },
    { u: noura, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-88213", issued: d(-350), expiry: d(15), verified: true, notes: "تجديد إلكتروني عبر ممارس بلس" },
    { u: noura, type: "iqama", issuer: MOI, cert: "IQ-2412345678", issued: d(-378), expiry: d(-12) },
    { u: noura, type: "passport", issuer: MOI, cert: "PP-A9812345", issued: d(-1000), expiry: d(825), verified: true },
    { u: noura, type: "infection_control", issuer: MOH, cert: "MOH-IC-4471", issued: d(-100), expiry: d(265) },
    // Fatimah — good standing
    { u: fatimah, type: "BLS", issuer: AHA, cert: "AHA-2025-90111", issued: d(-90), expiry: d(640), verified: true },
    { u: fatimah, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-71265", issued: d(-180), expiry: d(185) },
    { u: fatimah, type: "infection_control", issuer: MOH, cert: "MOH-IC-5583", issued: d(-60), expiry: d(305) },
    { u: fatimah, type: "iqama", issuer: MOI, cert: "IQ-2409876543", issued: d(-300), expiry: d(65) },
    { u: fatimah, type: "fire_safety", issuer: CD, cert: "CD-FS-2210", issued: d(-400), expiry: d(330) },
    // Mohammed — expired BLS
    { u: mohammed, type: "BLS", issuer: AHA, cert: "AHA-2023-33998", issued: d(-800), expiry: d(-70) },
    { u: mohammed, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-64110", issued: d(-500), expiry: d(230), verified: true },
    { u: mohammed, type: "iqama", issuer: MOI, cert: "IQ-2455512399", issued: d(-500), expiry: d(230) },
    // Aisha (ICU)
    { u: aisha, type: "BLS", issuer: AHA, cert: "AHA-2025-18276", issued: d(-150), expiry: d(580), verified: true },
    { u: aisha, type: "ACLS", issuer: AHA, cert: "AHA-2025-18277", issued: d(-150), expiry: d(580), verified: true },
    { u: aisha, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-90341", issued: d(-90), expiry: d(275) },
    { u: aisha, type: "infection_control", issuer: MOH, cert: "MOH-IC-6612", issued: d(-45), expiry: d(320) },
    { u: aisha, type: "iqama", issuer: MOI, cert: "IQ-2477765412", issued: d(-200), expiry: d(160) },
    { u: aisha, type: "fire_safety", issuer: CD, cert: "CD-FS-3341", issued: d(-100), expiry: d(265) },
    // Omar (ICU) — missing ACLS (required in ICU), expiring SCFHS
    { u: omar, type: "BLS", issuer: AHA, cert: "AHA-2024-55521", issued: d(-400), expiry: d(45) },
    { u: omar, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-51092", issued: d(-340), expiry: d(25) },
    { u: omar, type: "iqama", issuer: MOI, cert: "IQ-2433321109", issued: d(-365), expiry: d(0) },
    // Layla (ER)
    { u: layla, type: "BLS", issuer: AHA, cert: "AHA-2025-77190", issued: d(-30), expiry: d(700), verified: true },
    { u: layla, type: "TNCC", issuer: { en: "Emergency Nurses Association", ar: "جمعية ممرضي الطوارئ" }, cert: "ENA-2025-8823", issued: d(-120), expiry: d(610) },
    { u: layla, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-77120", issued: d(-200), expiry: d(165) },
    { u: layla, type: "iqama", issuer: MOI, cert: "IQ-2466612378", issued: d(-100), expiry: d(265) },
    // Yousef (ER) — several expired
    { u: yousef, type: "BLS", issuer: AHA, cert: "AHA-2023-11871", issued: d(-780), expiry: d(-50) },
    { u: yousef, type: "fire_safety", issuer: CD, cert: "CD-FS-1187", issued: d(-800), expiry: d(-435) },
    { u: yousef, type: "iqama", issuer: MOI, cert: "IQ-2422234567", issued: d(-400), expiry: d(330) },
    // Huda (Lab)
    { u: huda, type: "BLS", issuer: AHA, cert: "AHA-2025-63301", issued: d(-60), expiry: d(670) },
    { u: huda, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-83321", issued: d(-30), expiry: d(335), verified: true },
    { u: huda, type: "infection_control", issuer: MOH, cert: "MOH-IC-7781", issued: d(-90), expiry: d(275) },
    { u: huda, type: "iqama", issuer: MOI, cert: "IQ-2488876123", issued: d(-250), expiry: d(115) },
    // Supervisor Sara
    { u: supervisor, type: "BLS", issuer: AHA, cert: "AHA-2025-40092", issued: d(-100), expiry: d(630), verified: true },
    { u: supervisor, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-33019", issued: d(-250), expiry: d(115), verified: true },
    { u: supervisor, type: "infection_control", issuer: MOH, cert: "MOH-IC-2210", issued: d(-150), expiry: d(215) },
    { u: supervisor, type: "iqama", issuer: MOI, cert: "IQ-2411187654", issued: d(-300), expiry: d(65) },
    { u: supervisor, type: "fire_safety", issuer: CD, cert: "CD-FS-8891", issued: d(-200), expiry: d(165) },
    // Dept manager Muna
    { u: deptMgr, type: "BLS", issuer: AHA, cert: "AHA-2025-29981", issued: d(-120), expiry: d(610), verified: true },
    { u: deptMgr, type: "ACLS", issuer: AHA, cert: "AHA-2025-29982", issued: d(-120), expiry: d(610), verified: true },
    { u: deptMgr, type: "SCFHS_license", issuer: SCFHS, cert: "SCFHS-11220", issued: d(-400), expiry: d(-20) },
    { u: deptMgr, type: "medical_license", issuer: MOH, cert: "ML-99231", issued: d(-300), expiry: d(430), verified: true },
    { u: deptMgr, type: "iqama", issuer: MOI, cert: "IQ-2499912345", issued: d(-150), expiry: d(215) },
  ];

  const credRows = await db.insert(credentialsTable).values(
    specs.map((s) => ({
      employeeId: s.u.id,
      type: s.type,
      holderName: s.u.name,
      holderNameAr: s.u.nameAr,
      issuerName: s.issuer.en,
      issuerNameAr: s.issuer.ar,
      certificateNumber: s.cert,
      issueDate: s.issued,
      expiryDate: s.expiry,
      qrToken: qr(),
      tags: s.tags ?? [],
      notes: s.notes ?? null,
      isVerified: s.verified ?? false,
      confidence: s.verified ? 0.95 : null,
    })),
  ).returning();

  console.log("Creating notifications…");
  const credByEmpType = (empId: number, type: string) =>
    credRows.find((c) => c.employeeId === empId && c.type === type);
  const notif = (
    userId: number,
    type: "expiry_warning" | "expired" | "new_credential" | "system",
    titleAr: string,
    titleEn: string,
    messageAr: string,
    messageEn: string,
    credentialId: number | null,
    daysUntilExpiry: number | null,
    isRead: boolean,
    createdDaysAgo: number,
  ) => ({
    userId,
    type,
    titleAr,
    titleEn,
    messageAr,
    messageEn,
    credentialId,
    employeeId: userId,
    isRead,
    daysUntilExpiry,
    createdAt: daysAgo(createdDaysAgo),
  });

  await db.insert(notificationsTable).values([
    notif(noura.id, "expiry_warning", "تنبيه انتهاء صلاحية", "Expiry warning",
      "تنتهي صلاحية «ACLS» خلال 30 يوم", "Your ACLS expires in 30 days",
      credByEmpType(noura.id, "ACLS")?.id ?? null, 30, false, 2),
    notif(noura.id, "expiry_warning", "تنبيه انتهاء صلاحية", "Expiry warning",
      "تنتهي صلاحية «رخصة الهيئة» خلال 15 يوم", "Your SCFHS license expires in 15 days",
      credByEmpType(noura.id, "SCFHS_license")?.id ?? null, 15, false, 1),
    notif(noura.id, "expired", "وثيقة منتهية الصلاحية", "Credential expired",
      "انتهت صلاحية «الإقامة» منذ 12 يوماً", "Your Iqama expired 12 days ago",
      credByEmpType(noura.id, "iqama")?.id ?? null, -12, false, 5),
    notif(noura.id, "system", "مرحباً بك في وثائقي الصحي", "Welcome to HealthDocs",
      "ابدأ بإضافة وثائقك المهنية لتتبع صلاحيتها تلقائياً", "Start adding your professional credentials to track their expiry automatically",
      null, null, true, 30),
    notif(supervisor.id, "system", "موظفون في خطر", "Employees at risk",
      "لديك 2 من الموظفين لديهم وثائق منتهية تحتاج متابعة", "2 of your team members have expired credentials that need follow-up",
      null, null, false, 1),
    notif(deptMgr.id, "expired", "وثيقة منتهية الصلاحية", "Credential expired",
      "انتهت صلاحية «رخصة الهيئة» منذ 20 يوماً", "Your SCFHS license expired 20 days ago",
      credByEmpType(deptMgr.id, "SCFHS_license")?.id ?? null, -20, false, 3),
    notif(hospital.id, "system", "تقرير الامتثال الأسبوعي", "Weekly compliance report",
      "معدل الامتثال العام للمنشأة 78% هذا الأسبوع", "Facility-wide compliance is 78% this week",
      null, null, false, 2),
    notif(admin.id, "system", "نسخة احتياطية مكتملة", "Backup completed",
      "اكتملت النسخة الاحتياطية التلقائية لقاعدة البيانات", "Automatic database backup completed successfully",
      null, null, true, 7),
  ]);

  console.log("Creating audit logs…");
  const audit = (
    u: User,
    action: string,
    actionAr: string,
    target: string,
    targetAr: string,
    createdDaysAgo: number,
    details?: string,
  ) => ({
    userId: u.id,
    userName: u.name,
    userNameAr: u.nameAr,
    action,
    actionAr,
    target,
    targetAr,
    details: details ?? null,
    ipAddress: "10.0.4." + (10 + Math.floor(Math.random() * 80)),
    createdAt: daysAgo(createdDaysAgo),
  });

  await db.insert(auditLogsTable).values([
    audit(admin, "Signed in", "تسجيل دخول", "Session", "الجلسة", 0.1),
    audit(hospital, "Signed in", "تسجيل دخول", "Session", "الجلسة", 0.3),
    audit(supervisor, "Added credential", "إضافة وثيقة", "BLS · AHA-2025-40092", "BLS · AHA-2025-40092", 1),
    audit(noura, "Signed in", "تسجيل دخول", "Session", "الجلسة", 1.2),
    audit(noura, "Added credential", "إضافة وثيقة", "BLS · AHA-2025-73641", "BLS · AHA-2025-73641", 2),
    audit(deptMgr, "Updated employee", "تحديث موظف", "Omar Aldossari", "عمر الدوسري", 2.5),
    audit(hospital, "Created department", "إنشاء قسم", "Laboratory", "المختبر", 20),
    audit(hospital, "Added employee", "إضافة موظف", "Huda Alsubaie", "هدى السبيعي", 18),
    audit(admin, "Created policy", "إنشاء سياسة", "Requirement: BLS", "اشتراط: BLS", 25),
    audit(admin, "Created policy", "إنشاء سياسة", "Requirement: iqama", "اشتراط: iqama", 25),
    audit(supervisor, "Signed in", "تسجيل دخول", "Session", "الجلسة", 0.5),
    audit(fatimah, "Added credential", "إضافة وثيقة", "SCFHS_license · SCFHS-71265", "SCFHS_license · SCFHS-71265", 4),
    audit(mohammed, "Signed in", "تسجيل دخول", "Session", "الجلسة", 3),
    audit(aisha, "Added credential", "إضافة وثيقة", "ACLS · AHA-2025-18277", "ACLS · AHA-2025-18277", 6),
    audit(hospital, "Deactivated employee", "إيقاف موظف", "Temp Account", "حساب مؤقت", 12),
  ]);

  const counts = {
    users: (await db.select().from(usersTable)).length,
    departments: (await db.select().from(departmentsTable)).length,
    credentials: (await db.select().from(credentialsTable)).length,
    notifications: (await db.select().from(notificationsTable)).length,
    auditLogs: (await db.select().from(auditLogsTable)).length,
    policies: (await db.select().from(credentialPoliciesTable)).length,
  };
  console.log("Seed complete:", JSON.stringify(counts));
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
