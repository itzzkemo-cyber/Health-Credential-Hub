import {
  CredentialStatus,
  setRequestHandler,
  type AuthResponse,
  type Credential,
  type CredentialInput,
  type DashboardStats,
  type Notification,
  type OcrResult,
  type RequestHandler,
  type User,
} from "@workspace/api-client-react";

const employee: User = {
  id: 5,
  email: "employee@healthdocs.sa",
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

let credentials = createSeedCredentials();
let notifications = createSeedNotifications();
let nextCredentialId = 104;

export function resetShowcaseApiState(): void {
  credentials = createSeedCredentials();
  notifications = createSeedNotifications();
  nextCredentialId = 104;
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
    const url = new URL(rawUrl, "https://showcase.healthdocs.invalid");
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
      const response: AuthResponse = {
        token: "showcase-session",
        user: employee,
      };
      return json(response);
    }

    if (path === "/api/auth/me" && method === "GET") return json(employee);
    if (path === "/api/auth/logout" && method === "POST") return noContent();

    if (path === "/api/dashboard/stats" && method === "GET") {
      return json(buildDashboardStats());
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
      const search = url.searchParams.get("search")?.trim().toLowerCase();
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.max(
        1,
        Number(url.searchParams.get("pageSize") || 50),
      );
      const filtered = credentials.filter((credential) => {
        if (status && credential.status !== status) return false;
        if (type && credential.type !== type) return false;
        if (!search) return true;
        return [
          credential.type,
          credential.customTypeName,
          credential.customTypeNameAr,
          credential.issuerName,
          credential.issuerNameAr,
          credential.certificateNumber,
        ].some((value) => value?.toLowerCase().includes(search));
      });
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
      const credential: Credential = {
        id: nextCredentialId++,
        employeeId: employee.id,
        employee: employeeSummary(),
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
        createdAt: now,
        updatedAt: now,
      };
      credentials = [credential, ...credentials];
      notifications = [
        {
          id: Date.now(),
          userId: employee.id,
          type: "new_credential",
          titleAr: "تم استلام وثيقتك",
          titleEn: "Document received",
          messageAr: "حُفظت الوثيقة في العرض التجريبي وهي بانتظار المراجعة.",
          messageEn:
            "The document was saved in the showcase and awaits review.",
          credentialId: credential.id,
          employeeId: employee.id,
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
      const credential = credentials.find((item) => item.id === id);
      if (!credential) return problem(404, "Credential not found");
      if (method === "GET") return json(credential);
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
      issuerName: "HealthDocs Training Center",
      issuerNameAr: "مركز وثائقي الصحي للتدريب",
      certificateNumber: "IPC-19042",
      issueDate: shiftedDate(-420),
      expiryDate: shiftedDate(-55),
      isVerified: true,
    }),
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
): Credential {
  return {
    ...values,
    employeeId: employee.id,
    employee: employeeSummary(),
    customTypeName: null,
    customTypeNameAr: null,
    holderName: employee.name,
    holderNameAr: employee.nameAr,
    status: statusFor(values.expiryDate),
    fileUrl: null,
    fileType: null,
    qrToken: `showcase-credential-${values.id}`,
    tags: [],
    notes: null,
    verificationUrl: null,
    confidence: null,
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
  const active = credentials.filter((item) => item.status === "active").length;
  const expiring = credentials.filter(
    (item) => item.status === "expiring_soon",
  ).length;
  const expired = credentials.filter(
    (item) => item.status === "expired",
  ).length;
  return {
    totalCredentials: credentials.length,
    activeCredentials: active,
    expiringCredentials: expiring,
    expiredCredentials: expired,
    missingCredentials: 1,
    complianceRate:
      credentials.length === 0
        ? 0
        : Math.round(((active + expiring) / (credentials.length + 1)) * 100),
    totalEmployees: 1,
    atRiskEmployees: expired > 0 ? 1 : 0,
    upcomingExpirations: credentials
      .filter((item) => item.status === "expiring_soon")
      .slice(0, 5),
    recentActivity: [],
  };
}

function employeeSummary() {
  return {
    id: employee.id,
    name: employee.name,
    nameAr: employee.nameAr,
    jobTitle: employee.jobTitle ?? "Registered Nurse",
    jobTitleAr: employee.jobTitleAr ?? "ممرضة مسجلة",
    avatarUrl: employee.avatarUrl,
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
