import {
  CredentialStatus,
  setRequestHandler,
  type AuthResponse,
  type Credential,
  type CredentialInput,
  type CredentialUpdate,
  type DashboardStats,
  type DemoLoginInputRole,
  type EmployeeDetail,
  type EmployeeWithStats,
  type Notification,
  type OcrResult,
  type RequestHandler,
  type User,
} from "@workspace/api-client-react";

const employee: User = {
  id: 5,
  email: "employee@demo.wathaiqi.invalid",
  name: "Noura Alqahtani",
  nameAr: "نورة القحطاني",
  role: "employee",
  departmentId: 1,
  supervisorId: 4,
  facilityId: 1,
  jobTitle: "Registered Nurse",
  jobTitleAr: "ممرضة مسجلة",
  employeeNumber: "EMP-1005",
  phone: "0500000000",
  avatarUrl: null,
  isActive: true,
  totpEnabled: false,
  createdAt: shiftedIso(-480),
};

const supervisor: User = {
  ...employee,
  id: 4,
  email: "supervisor@demo.wathaiqi.invalid",
  name: "Omar Alharbi",
  nameAr: "عمر الحربي",
  role: "supervisor",
  supervisorId: null,
  jobTitle: "Nursing Supervisor",
  jobTitleAr: "مشرف تمريض",
  employeeNumber: "SUP-1004",
};

const departmentManager: User = {
  ...employee,
  id: 3,
  email: "dept@demo.wathaiqi.invalid",
  name: "Sara Alotaibi",
  nameAr: "سارة العتيبي",
  role: "department_manager",
  supervisorId: null,
  jobTitle: "Department Manager",
  jobTitleAr: "مديرة القسم",
  employeeNumber: "MGR-1003",
};

const hospitalAdmin: User = {
  ...employee,
  id: 2,
  email: "hospital@demo.wathaiqi.invalid",
  name: "Khalid Alqahtani",
  nameAr: "خالد القحطاني",
  role: "hospital_admin",
  departmentId: null,
  supervisorId: null,
  jobTitle: "Hospital Administrator",
  jobTitleAr: "مدير المنشأة",
  employeeNumber: "ADM-1002",
};

const systemAdmin: User = {
  ...hospitalAdmin,
  id: 1,
  email: "admin@demo.wathaiqi.invalid",
  name: "Watha'iqi Health Admin",
  nameAr: "مسؤول وثائقي الصحية",
  role: "system_admin",
  employeeNumber: "SYS-1001",
};

const secondEmployee: User = {
  ...employee,
  id: 6,
  email: "fahad@demo.wathaiqi.invalid",
  name: "Fahad Almutairi",
  nameAr: "فهد المطيري",
  jobTitle: "Emergency Nurse",
  jobTitleAr: "ممرض طوارئ",
  employeeNumber: "EMP-1006",
};

const pharmacyEmployee: User = {
  ...employee,
  id: 7,
  email: "reem@demo.wathaiqi.invalid",
  name: "Reem Alzahrani",
  nameAr: "ريم الزهراني",
  departmentId: 2,
  supervisorId: null,
  jobTitle: "Clinical Pharmacist",
  jobTitleAr: "صيدلانية سريرية",
  employeeNumber: "EMP-1007",
};

const showcaseAccounts: Record<DemoLoginInputRole, User> = {
  employee,
  supervisor,
  department_manager: departmentManager,
  hospital_admin: hospitalAdmin,
  system_admin: systemAdmin,
};

const showcaseStaff = [
  departmentManager,
  supervisor,
  employee,
  secondEmployee,
  pharmacyEmployee,
];

let credentials = createSeedCredentials();
let notifications = createSeedNotifications();
let nextCredentialId = 107;
let currentUser: User = employee;

export function resetShowcaseApiState(): void {
  credentials = createSeedCredentials();
  notifications = createSeedNotifications();
  nextCredentialId = 107;
  currentUser = employee;
}

export function enableShowcaseApi(): void {
  resetShowcaseApiState();
  setRequestHandler(createShowcaseRequestHandler());
}

export function createShowcaseRequestHandler(): RequestHandler {
  return async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl, "https://showcase.wathaiqi.invalid");
    const path = url.pathname;
    const method = (init.method ?? "GET").toUpperCase();

    if (!path.startsWith("/api/")) return undefined;

    if (path === "/api/healthz" && method === "GET") {
      return json({ status: "ok", mode: "showcase" });
    }

    if (
      (path === "/api/auth/demo-login" || path === "/api/auth/login") &&
      method === "POST"
    ) {
      const input = await readJson<{ role?: DemoLoginInputRole }>(init);
      currentUser = input?.role
        ? (showcaseAccounts[input.role] ?? employee)
        : employee;
      const response: AuthResponse = {
        token: "showcase-session",
        user: currentUser,
      };
      return json(response);
    }

    if (path === "/api/auth/me" && method === "GET") return json(currentUser);
    if (path === "/api/auth/logout" && method === "POST") return noContent();

    if (path === "/api/dashboard/stats" && method === "GET") {
      return json(buildDashboardStats());
    }

    if (path === "/api/employees" && method === "GET") {
      const search = url.searchParams.get("search")?.trim().toLowerCase();
      const departmentId = Number(url.searchParams.get("departmentId"));
      const supervisorId = Number(url.searchParams.get("supervisorId"));
      const role = url.searchParams.get("role");
      const active = url.searchParams.get("isActive");
      const employees = visibleEmployeesFor(currentUser)
        .filter((item) => {
          if (
            Number.isFinite(departmentId) &&
            departmentId > 0 &&
            item.departmentId !== departmentId
          )
            return false;
          if (
            Number.isFinite(supervisorId) &&
            supervisorId > 0 &&
            item.supervisorId !== supervisorId
          )
            return false;
          if (role && item.role !== role) return false;
          if (active === "true" && !item.isActive) return false;
          if (active === "false" && item.isActive) return false;
          if (!search) return true;
          return [item.name, item.nameAr, item.email, item.employeeNumber].some(
            (value) => value?.toLowerCase().includes(search),
          );
        })
        .map(employeeWithStats);
      return json(employees);
    }

    const employeeMatch = path.match(/^\/api\/employees\/(\d+)$/);
    if (employeeMatch && method === "GET") {
      const id = Number(employeeMatch[1]);
      const target = visibleEmployeesFor(currentUser).find(
        (item) => item.id === id,
      );
      if (!target) return problem(404, "Employee not found");
      return json(employeeDetail(target));
    }

    if (path === "/api/credentials/ocr" && method === "POST") {
      const result: OcrResult = {
        detectedType: "BLS",
        holderName: employee.name,
        holderNameAr: employee.nameAr,
        issuerName: "Saudi Heart Association",
        issuerNameAr: "جمعية القلب السعودية",
        certificateNumber: `SHA-${new Date().getFullYear()}-2048`,
        issueDate: shiftedDate(-45),
        expiryDate: shiftedDate(320),
        confidence: {
          overall: 0.94,
          type: 0.97,
          name: 0.96,
          issuer: 0.92,
          certNumber: 0.93,
          issueDate: 0.91,
          expiryDate: 0.94,
        },
      };
      return json(result);
    }

    if (path === "/api/credentials" && method === "GET") {
      const status = url.searchParams.get("status");
      const type = url.searchParams.get("type");
      const rawIsVerified = url.searchParams.get("isVerified");
      if (
        rawIsVerified !== null &&
        rawIsVerified !== "true" &&
        rawIsVerified !== "false"
      ) {
        return problem(400, "isVerified must be true or false");
      }
      const search = url.searchParams.get("search")?.trim().toLowerCase();
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.max(
        1,
        Number(url.searchParams.get("pageSize") || 50),
      );
      const filtered = scopedCredentialsFor(currentUser).filter(
        (credential) => {
          if (status && credential.status !== status) return false;
          if (type && credential.type !== type) return false;
          if (
            rawIsVerified !== null &&
            credential.isVerified !== (rawIsVerified === "true")
          ) {
            return false;
          }
          if (!search) return true;
          return [
            credential.type,
            credential.customTypeName,
            credential.customTypeNameAr,
            credential.issuerName,
            credential.issuerNameAr,
            credential.certificateNumber,
          ].some((value) => value?.toLowerCase().includes(search));
        },
      );
      const start = (page - 1) * pageSize;
      return json({
        data: filtered.slice(start, start + pageSize),
        total: filtered.length,
        page,
        pageSize,
      });
    }

    if (path === "/api/credentials" && method === "POST") {
      const data = await readJson<CredentialInput>(init);
      if (!data) return problem(400, "Missing credential data");
      const issueTime = Date.parse(data.issueDate);
      const expiryTime = Date.parse(data.expiryDate);
      if (
        !Number.isFinite(issueTime) ||
        !Number.isFinite(expiryTime) ||
        issueTime > expiryTime
      ) {
        return problem(400, "Valid issue and expiry dates are required");
      }
      const now = new Date().toISOString();
      const requestedOwner = showcaseStaff.find(
        (item) => item.id === data.employeeId,
      );
      const owner =
        currentUser.role === "employee"
          ? currentUser
          : requestedOwner &&
              visibleEmployeesFor(currentUser).some(
                (item) => item.id === requestedOwner.id,
              )
            ? requestedOwner
            : employee;
      const credential: Credential = {
        id: nextCredentialId++,
        employeeId: owner.id,
        employee: employeeSummary(owner),
        type: data.type,
        customTypeName: data.customTypeName ?? null,
        customTypeNameAr: data.customTypeNameAr ?? null,
        holderName: data.holderName,
        holderNameAr: data.holderNameAr,
        issuerName: data.issuerName,
        issuerNameAr: data.issuerNameAr,
        certificateNumber: data.certificateNumber,
        issueDate: data.issueDate,
        expiryDate: data.expiryDate,
        status: statusFor(data.expiryDate),
        fileUrl: data.fileUrl ?? null,
        fileType: data.fileType ?? null,
        qrToken: `showcase-${nextCredentialId}-${Date.now()}`,
        tags: data.tags ?? [],
        notes: data.notes ?? null,
        verificationUrl: null,
        confidence: data.confidence ?? null,
        isVerified: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      credentials = [credential, ...credentials];
      notifications = [
        {
          id: Date.now(),
          userId: owner.id,
          type: "new_credential",
          titleAr: "تم استلام وثيقتك",
          titleEn: "Document received",
          messageAr: "حُفظت الوثيقة في العرض التجريبي وهي بانتظار المراجعة.",
          messageEn:
            "The document was saved in the showcase and awaits review.",
          credentialId: credential.id,
          employeeId: owner.id,
          isRead: false,
          daysUntilExpiry: null,
          createdAt: now,
        },
        ...notifications,
      ];
      return json(credential, 201);
    }

    const verifyMatch = path.match(/^\/api\/credentials\/([^/]+)\/verify$/);
    if (verifyMatch && method === "GET") {
      const credential = credentials.find(
        (item) => item.qrToken === verifyMatch[1],
      );
      if (!credential) return problem(404, "Credential not found");
      return json({
        type: credential.type,
        issuerName: credential.issuerName,
        issueDate: credential.issueDate,
        expiryDate: credential.expiryDate,
        status: credential.status,
        verificationCode: credential.qrToken,
      });
    }

    const credentialMatch = path.match(/^\/api\/credentials\/(\d+)$/);
    if (credentialMatch) {
      const id = Number(credentialMatch[1]);
      const credential = scopedCredentialsFor(currentUser).find(
        (item) => item.id === id,
      );
      if (!credential) return problem(404, "Credential not found");
      if (method === "GET") return json(credential);
      if (method === "PATCH") {
        const body = await readJson<CredentialUpdate>(init);
        if (!body || body.expectedVersion !== credential.version)
          return problem(409, "Credential version conflict");
        if (
          typeof body.isVerified === "boolean" &&
          ![
            "supervisor",
            "department_manager",
            "hospital_admin",
            "system_admin",
          ].includes(currentUser.role)
        )
          return problem(403, "Credential verification is not allowed");

        const updated: Credential = {
          ...credential,
          isVerified: body.isVerified ?? credential.isVerified,
          version: credential.version + 1,
          updatedAt: new Date().toISOString(),
        };
        credentials = credentials.map((item) =>
          item.id === updated.id ? updated : item,
        );
        return json(updated);
      }
      if (method === "DELETE") {
        credentials = credentials.filter((item) => item.id !== id);
        return noContent();
      }
    }

    if (path === "/api/notifications" && method === "GET") {
      const unreadOnly = url.searchParams.get("unreadOnly") === "true";
      return json(
        unreadOnly
          ? notifications.filter((item) => !item.isRead)
          : notifications,
      );
    }
    if (path === "/api/notifications/unread-count" && method === "GET") {
      return json({
        count: notifications.filter((item) => !item.isRead).length,
      });
    }
    if (path === "/api/notifications/mark-all-read" && method === "POST") {
      notifications = notifications.map((item) => ({ ...item, isRead: true }));
      return noContent();
    }
    const notificationMatch = path.match(/^\/api\/notifications\/(\d+)\/read$/);
    if (notificationMatch && method === "POST") {
      const id = Number(notificationMatch[1]);
      notifications = notifications.map((item) =>
        item.id === id ? { ...item, isRead: true } : item,
      );
      return noContent();
    }

    // A showcase must never silently contact a real API for an unimplemented
    // application route. Return an explicit synthetic response instead.
    return problem(404, `Not available in showcase: ${method} ${path}`);
  };
}

function createSeedCredentials(): Credential[] {
  return [
    credentialSeed({
      id: 101,
      type: "SCFHS_license",
      issuerName: "Saudi Commission for Health Specialties",
      issuerNameAr: "الهيئة السعودية للتخصصات الصحية",
      certificateNumber: "SCFHS-RN-48291",
      issueDate: shiftedDate(-210),
      expiryDate: shiftedDate(155),
      isVerified: true,
    }),
    credentialSeed({
      id: 102,
      type: "BLS",
      issuerName: "Saudi Heart Association",
      issuerNameAr: "جمعية القلب السعودية",
      certificateNumber: "SHA-BLS-77204",
      issueDate: shiftedDate(-330),
      expiryDate: shiftedDate(35),
      isVerified: true,
    }),
    credentialSeed({
      id: 103,
      type: "infection_control",
      issuerName: "Watha'iqi Health Training Center",
      issuerNameAr: "مركز وثائقي الصحية للتدريب",
      certificateNumber: "IPC-19042",
      issueDate: shiftedDate(-420),
      expiryDate: shiftedDate(-55),
      isVerified: true,
    }),
    credentialSeed(
      {
        id: 104,
        type: "BLS",
        issuerName: "Saudi Heart Association",
        issuerNameAr: "جمعية القلب السعودية",
        certificateNumber: "SHA-BLS-88412",
        issueDate: shiftedDate(-20),
        expiryDate: shiftedDate(345),
        isVerified: false,
      },
      secondEmployee,
    ),
    credentialSeed(
      {
        id: 105,
        type: "fire_safety",
        issuerName: "Hospital Safety Academy",
        issuerNameAr: "أكاديمية سلامة المنشآت الصحية",
        certificateNumber: "FIRE-2026-610",
        issueDate: shiftedDate(-60),
        expiryDate: shiftedDate(305),
        isVerified: true,
      },
      secondEmployee,
    ),
    credentialSeed(
      {
        id: 106,
        type: "SCFHS_license",
        issuerName: "Saudi Commission for Health Specialties",
        issuerNameAr: "الهيئة السعودية للتخصصات الصحية",
        certificateNumber: "SCFHS-PH-29108",
        issueDate: shiftedDate(-10),
        expiryDate: shiftedDate(355),
        isVerified: false,
      },
      pharmacyEmployee,
    ),
  ];
}

function credentialSeed(
  values: Pick<
    Credential,
    | "id"
    | "type"
    | "issuerName"
    | "issuerNameAr"
    | "certificateNumber"
    | "issueDate"
    | "expiryDate"
    | "isVerified"
  >,
  owner: User = employee,
): Credential {
  return {
    ...values,
    employeeId: owner.id,
    employee: employeeSummary(owner),
    customTypeName: null,
    customTypeNameAr: null,
    holderName: owner.name,
    holderNameAr: owner.nameAr,
    status: statusFor(values.expiryDate),
    fileUrl: null,
    fileType: null,
    qrToken: `showcase-credential-${values.id}`,
    tags: [],
    notes: null,
    verificationUrl: null,
    confidence: null,
    version: 1,
    createdAt: shiftedIso(-240),
    updatedAt: shiftedIso(-30),
  };
}

function createSeedNotifications(): Notification[] {
  return [
    {
      id: 201,
      userId: employee.id,
      type: "expiry_warning",
      titleAr: "وثيقة ستنتهي قريبًا",
      titleEn: "Document expiring soon",
      messageAr: "شهادة دعم الحياة الأساسي تحتاج إلى تجديد.",
      messageEn: "Your Basic Life Support certificate needs renewal.",
      credentialId: 102,
      employeeId: employee.id,
      isRead: false,
      daysUntilExpiry: 35,
      createdAt: shiftedIso(-2),
    },
    {
      id: 202,
      userId: employee.id,
      type: "system",
      titleAr: "مرحبًا بك في العرض التجريبي",
      titleEn: "Welcome to the showcase",
      messageAr: "جميع البيانات هنا صناعية وتُمسح عند تحديث الصفحة.",
      messageEn: "All data here is synthetic and resets when the page reloads.",
      credentialId: null,
      employeeId: employee.id,
      isRead: true,
      daysUntilExpiry: null,
      createdAt: shiftedIso(-5),
    },
  ];
}

function buildDashboardStats(): DashboardStats {
  const scopedCredentials = scopedCredentialsFor(currentUser);
  const scopedEmployees =
    currentUser.role === "employee"
      ? [currentUser]
      : visibleEmployeesFor(currentUser);
  const active = scopedCredentials.filter(
    (item) => item.status === "active",
  ).length;
  const expiring = scopedCredentials.filter(
    (item) => item.status === "expiring_soon",
  ).length;
  const expired = scopedCredentials.filter(
    (item) => item.status === "expired",
  ).length;
  return {
    totalCredentials: scopedCredentials.length,
    activeCredentials: active,
    expiringCredentials: expiring,
    expiredCredentials: expired,
    missingCredentials: 1,
    complianceRate:
      scopedCredentials.length === 0
        ? 0
        : Math.round(
            ((active + expiring) / (scopedCredentials.length + 1)) * 100,
          ),
    totalEmployees: scopedEmployees.length,
    atRiskEmployees: expired > 0 ? 1 : 0,
    upcomingExpirations: scopedCredentials
      .filter((item) => item.status === "expiring_soon")
      .slice(0, 5),
    recentActivity: [],
  };
}

function employeeSummary(owner: User = employee) {
  return {
    id: owner.id,
    name: owner.name,
    nameAr: owner.nameAr,
    jobTitle: owner.jobTitle ?? "Healthcare Professional",
    jobTitleAr: owner.jobTitleAr ?? "ممارس صحي",
    avatarUrl: owner.avatarUrl,
  };
}

function visibleEmployeesFor(user: User): User[] {
  const rank: Record<User["role"], number> = {
    employee: 0,
    supervisor: 1,
    department_manager: 2,
    hospital_admin: 3,
    system_admin: 4,
  };
  const lowerRanked = showcaseStaff.filter(
    (item) => item.id !== user.id && rank[item.role] < rank[user.role],
  );

  switch (user.role) {
    case "supervisor":
      return lowerRanked.filter((item) => item.supervisorId === user.id);
    case "department_manager":
      return lowerRanked.filter(
        (item) => item.departmentId === user.departmentId,
      );
    case "hospital_admin":
      return lowerRanked.filter((item) => item.facilityId === user.facilityId);
    case "system_admin":
      return lowerRanked;
    default:
      return [];
  }
}

function scopedCredentialsFor(user: User): Credential[] {
  if (user.role === "employee")
    return credentials.filter((item) => item.employeeId === user.id);
  const visibleIds = new Set(visibleEmployeesFor(user).map((item) => item.id));
  return credentials.filter((item) => visibleIds.has(item.employeeId));
}

function employeeWithStats(owner: User): EmployeeWithStats {
  const ownedCredentials = credentials.filter(
    (item) => item.employeeId === owner.id,
  );
  const validCount = ownedCredentials.filter(
    (item) => item.status === "active" || item.status === "expiring_soon",
  ).length;
  const expiredCount = ownedCredentials.filter(
    (item) => item.status === "expired",
  ).length;
  const expiringCount = ownedCredentials.filter(
    (item) => item.status === "expiring_soon",
  ).length;

  return {
    ...owner,
    department:
      owner.departmentId === 1
        ? { id: 1, name: "Nursing", nameAr: "التمريض" }
        : owner.departmentId === 2
          ? { id: 2, name: "Pharmacy", nameAr: "الصيدلية" }
          : undefined,
    complianceRate:
      ownedCredentials.length === 0
        ? 0
        : Math.round((validCount / ownedCredentials.length) * 100),
    totalCredentials: ownedCredentials.length,
    expiredCount,
    expiringCount,
    missingCount: ownedCredentials.length === 0 ? 1 : 0,
    isAtRisk: expiredCount > 0 || ownedCredentials.length === 0,
  };
}

function employeeDetail(owner: User): EmployeeDetail {
  return {
    ...employeeWithStats(owner),
    credentials: credentials.filter((item) => item.employeeId === owner.id),
    missingCredentials: credentials.some((item) => item.employeeId === owner.id)
      ? []
      : ["BLS"],
  };
}

function statusFor(expiryDate: string): CredentialStatus {
  const remainingDays = Math.ceil(
    (new Date(expiryDate).getTime() - startOfToday().getTime()) / 86_400_000,
  );
  if (remainingDays < 0) return "expired";
  if (remainingDays <= 90) return "expiring_soon";
  return "active";
}

async function readJson<T>(init: RequestInit): Promise<T | null> {
  if (typeof init.body !== "string") return null;
  try {
    return JSON.parse(init.body) as T;
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function problem(status: number, message: string): Response {
  return json({ message, code: "SHOWCASE_ROUTE_UNAVAILABLE" }, status);
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function startOfToday(): Date {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  return value;
}

function shiftedDate(days: number): string {
  const value = startOfToday();
  value.setDate(value.getDate() + days);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftedIso(days: number): string {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString();
}
