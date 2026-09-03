import { Router, type IRouter, type Request } from "express";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  db,
  usersTable,
  shiftSchedulesTable,
  shiftScheduleMembersTable,
  scheduleRequestsTable,
  notificationsTable,
  auditLogsTable,
  type User,
  type ShiftScheduleRow,
  type ScheduleRequestRow,
  type ScheduleConfiguration,
} from "@workspace/db";
import {
  CreateScheduleRequestBody,
  GetScheduleRequestsForReviewQueryParams,
  WithdrawScheduleRequestBody,
  DecideScheduleRequestBody,
} from "@workspace/api-zod";
import { getUser, MANAGER_ROLES, requireAuth, requireRole } from "../lib/auth";
import { ROLE_RANK } from "../lib/roleHierarchy";
import { rateLimit } from "../lib/rateLimit";
import {
  evaluateScheduleRequestFeasibility,
  type ScheduleRequestEvaluationInput,
} from "../lib/scheduleRequestFeasibility";
import type {
  AdjacentAssignment,
  SchedulePlanningInput,
  ShiftAssignment,
} from "../lib/shiftScheduling";
import { scheduleRequestLifecycleEvent } from "../lib/automation/events";
import { enqueueAutomationEvent } from "../lib/automation/outbox";

const router: IRouter = Router();
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const createBody = CreateScheduleRequestBody.strict();
const reviewQuery = GetScheduleRequestsForReviewQueryParams.strict();
const withdrawBody = WithdrawScheduleRequestBody.strict();
const decisionBody = DecideScheduleRequestBody.strict();
const DATE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAY_MS = 86_400_000;

type RequestUser = Pick<
  User,
  | "id"
  | "name"
  | "nameAr"
  | "role"
  | "facilityId"
  | "departmentId"
  | "supervisorId"
  | "isActive"
>;
type RequestActor = RequestUser & Pick<User, "sessionVersion">;

const requestUserColumns = {
  id: usersTable.id,
  name: usersTable.name,
  nameAr: usersTable.nameAr,
  role: usersTable.role,
  facilityId: usersTable.facilityId,
  departmentId: usersTable.departmentId,
  supervisorId: usersTable.supervisorId,
  isActive: usersTable.isActive,
};

const requestActorColumns = {
  ...requestUserColumns,
  // Needed only to re-check that the authenticated session was not revoked
  // while waiting for the actor row lock.
  sessionVersion: usersTable.sessionVersion,
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function failure(status: number, code: string): never {
  throw new RequestError(status, code);
}

function idFrom(req: Request): number {
  const value = String(req.params.id);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    failure(400, "invalid_schedule_request_id");
  return Number(value);
}

function isExactDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

export function validateScheduleRequestShape(input: {
  kind: "leave" | "preferred_shift" | "off" | "eo";
  startDate: string;
  endDate: string;
  shiftCode?: string;
  note?: string;
}): string | null {
  if (!isExactDate(input.startDate) || !isExactDate(input.endDate))
    return "invalid_request_date";
  const start = Date.parse(`${input.startDate}T00:00:00Z`);
  const end = Date.parse(`${input.endDate}T00:00:00Z`);
  if (
    end < start ||
    input.startDate.slice(0, 7) !== input.endDate.slice(0, 7) ||
    (end - start) / DAY_MS + 1 > 31
  )
    return "invalid_request_range";
  if (input.kind !== "leave" && input.startDate !== input.endDate)
    return "single_day_request_required";
  if (
    input.kind === "preferred_shift"
      ? !input.shiftCode
      : input.shiftCode != null
  )
    return "invalid_request_shift";
  if (input.note != null && !input.note.trim()) return "invalid_request_note";
  return null;
}

export function scheduleRequestAuditDetails(
  row: Pick<
    ScheduleRequestRow,
    "id" | "status" | "rowVersion" | "feasibilityStatus"
  >,
): string {
  return JSON.stringify({
    requestId: row.id,
    status: row.status,
    version: row.rowVersion,
    feasibilityStatus: row.feasibilityStatus,
  });
}

type ScheduleRequestWindow = Pick<
  ScheduleRequestRow,
  "id" | "employeeId" | "startDate" | "endDate" | "status"
>;

export function hasConflictingApprovedScheduleRequest(
  candidate: ScheduleRequestWindow,
  approvedRequests: ScheduleRequestWindow[],
): boolean {
  return approvedRequests.some(
    (approved) =>
      approved.id !== candidate.id &&
      approved.employeeId === candidate.employeeId &&
      approved.status === "approved" &&
      approved.startDate <= candidate.endDate &&
      approved.endDate >= candidate.startDate,
  );
}

export function scheduleRequestDecisionMode(
  currentStatus: ScheduleRequestRow["status"],
  decision: "approved" | "rejected",
): "initial" | "revocation" | null {
  if (currentStatus === "pending") return "initial";
  if (currentStatus === "approved" && decision === "rejected")
    return "revocation";
  return null;
}

export function scheduleRequestDecisionIssue(
  current: Pick<ScheduleRequestRow, "status" | "rowVersion">,
  expectedVersion: number,
  decision: "approved" | "rejected",
): string | null {
  if (current.rowVersion !== expectedVersion)
    return "schedule_request_version_conflict";
  if (!scheduleRequestDecisionMode(current.status, decision))
    return "schedule_request_not_decidable";
  return null;
}

function evaluationInput(
  row: Pick<
    ScheduleRequestRow,
    "employeeId" | "kind" | "startDate" | "endDate" | "shiftCode"
  >,
): ScheduleRequestEvaluationInput {
  return {
    employeeId: row.employeeId,
    kind: row.kind,
    startDate: row.startDate,
    endDate: row.endDate,
    shiftCode: row.shiftCode,
  };
}

function planningInput(row: ShiftScheduleRow): SchedulePlanningInput {
  return { ...row.configuration, title: row.title, month: row.month };
}

export function serializeScheduleRequest(
  row: ScheduleRequestRow,
  employee: RequestUser,
  exposure: "employee" | "review",
) {
  const employeeProjection = exposure === "employee";
  return {
    id: row.id,
    employee: {
      id: employee.id,
      name: employee.name,
      nameAr: employee.nameAr,
    },
    kind: row.kind,
    startDate: row.startDate,
    endDate: row.endDate,
    shiftCode: row.shiftCode,
    note: row.note,
    status: row.status,
    version: row.rowVersion,
    feasibility: {
      status: row.feasibilityStatus,
      // Employees receive the advisory status but never draft identifiers,
      // versions, staffing shortages, or constraint-specific reason codes.
      reasonCodes: employeeProjection
        ? ["generic"]
        : row.feasibilityReasonCodes,
      scheduleId: employeeProjection ? null : row.evaluatedScheduleId,
      scheduleVersion: employeeProjection ? null : row.evaluatedScheduleVersion,
      evaluatedAt: row.evaluatedAt.toISOString(),
    },
    // Reviewer identity is managerial metadata. Employees only need the
    // decision state and timestamp, not an internal user identifier.
    decidedBy: employeeProjection ? null : row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Current hierarchy and current tenant scope; historical IDs never bypass it. */
export function canReviewScheduleRequest(
  actor: RequestUser,
  target: RequestUser,
  requestFacilityId: number,
): boolean {
  if (
    !actor.isActive ||
    !target.isActive ||
    actor.id === target.id ||
    target.facilityId !== requestFacilityId ||
    !MANAGER_ROLES.includes(actor.role)
  )
    return false;
  if (actor.role !== "system_admin" && actor.facilityId !== requestFacilityId)
    return false;
  const inScope =
    actor.role === "system_admin" ||
    (actor.role === "hospital_admin" &&
      actor.facilityId === target.facilityId) ||
    (actor.role === "department_manager" &&
      actor.facilityId === target.facilityId &&
      actor.departmentId != null &&
      actor.departmentId === target.departmentId) ||
    (actor.role === "supervisor" &&
      actor.facilityId === target.facilityId &&
      target.supervisorId === actor.id);
  const lowerRank =
    actor.role === "system_admin"
      ? target.role !== "system_admin"
      : ROLE_RANK[target.role] < ROLE_RANK[actor.role];
  return inScope && lowerRank;
}

function reviewScopeCondition(actor: RequestUser): SQL {
  const common = and(
    eq(usersTable.isActive, true),
    ne(usersTable.id, actor.id),
    eq(scheduleRequestsTable.facilityId, usersTable.facilityId),
  )!;
  if (actor.role === "system_admin")
    return and(common, ne(usersTable.role, "system_admin"))!;
  if (actor.role === "hospital_admin")
    return and(
      common,
      eq(usersTable.facilityId, actor.facilityId),
      inArray(usersTable.role, [
        "employee",
        "supervisor",
        "department_manager",
      ]),
    )!;
  if (actor.role === "department_manager")
    return and(
      common,
      eq(usersTable.facilityId, actor.facilityId),
      actor.departmentId == null
        ? sql`false`
        : eq(usersTable.departmentId, actor.departmentId),
      inArray(usersTable.role, ["employee", "supervisor"]),
    )!;
  if (actor.role === "supervisor")
    return and(
      common,
      eq(usersTable.facilityId, actor.facilityId),
      eq(usersTable.supervisorId, actor.id),
      eq(usersTable.role, "employee"),
    )!;
  return sql`false`;
}

function reviewerScopeCondition(employee: RequestUser): SQL {
  const eligible: SQL[] = [];
  if (employee.role === "employee" && employee.supervisorId != null)
    eligible.push(
      and(
        eq(usersTable.id, employee.supervisorId),
        eq(usersTable.role, "supervisor"),
      )!,
    );
  if (
    (employee.role === "employee" || employee.role === "supervisor") &&
    employee.departmentId != null
  )
    eligible.push(
      and(
        eq(usersTable.role, "department_manager"),
        eq(usersTable.departmentId, employee.departmentId),
      )!,
    );
  if (
    employee.role === "employee" ||
    employee.role === "supervisor" ||
    employee.role === "department_manager"
  )
    eligible.push(eq(usersTable.role, "hospital_admin"));
  return and(
    eq(usersTable.isActive, true),
    eq(usersTable.facilityId, employee.facilityId),
    ne(usersTable.id, employee.id),
    eligible.length ? or(...eligible) : sql`false`,
  )!;
}

async function lockedActor(
  tx: Transaction,
  requestUser: User,
  mode: "share" | "update",
  manager = false,
): Promise<RequestActor> {
  const actor = (
    await tx
      .select(requestActorColumns)
      .from(usersTable)
      .where(eq(usersTable.id, requestUser.id))
      .for(mode)
  )[0];
  if (
    !actor ||
    actor.id !== requestUser.id ||
    !actor.isActive ||
    actor.sessionVersion !== requestUser.sessionVersion
  )
    failure(401, "unauthorized");
  if (manager && !MANAGER_ROLES.includes(actor.role)) failure(403, "forbidden");
  return actor;
}

async function lockedActorAndTarget(
  tx: Transaction,
  requestUser: User,
  targetId: number,
): Promise<{ actor: RequestActor; target: RequestUser }> {
  if (requestUser.id === targetId) failure(404, "schedule_request_not_found");
  let actor: RequestActor | undefined;
  let target: RequestUser | undefined;
  const lockActor = async () => {
    actor = (
      await tx
        .select(requestActorColumns)
        .from(usersTable)
        .where(eq(usersTable.id, requestUser.id))
        .for("update")
    )[0];
  };
  const lockTarget = async () => {
    target = (
      await tx
        .select(requestUserColumns)
        .from(usersTable)
        .where(eq(usersTable.id, targetId))
        .for("update")
    )[0];
  };
  // Preserve the global user-row lock order while projecting sessionVersion
  // only for the authenticated actor who needs freshness verification.
  if (requestUser.id < targetId) {
    await lockActor();
    await lockTarget();
  } else {
    await lockTarget();
    await lockActor();
  }
  if (
    !actor ||
    actor.id !== requestUser.id ||
    !actor.isActive ||
    actor.sessionVersion !== requestUser.sessionVersion
  )
    failure(401, "unauthorized");
  if (!target || !canReviewScheduleRequest(actor, target, target.facilityId))
    failure(404, "schedule_request_not_found");
  return { actor, target };
}

async function scheduleForRequest(
  tx: Transaction,
  request: ScheduleRequestEvaluationInput,
  facilityId: number,
  publishedOnly: boolean,
): Promise<ShiftScheduleRow | null> {
  const month = request.startDate.slice(0, 7);
  return (
    (
      await tx
        .select()
        .from(shiftSchedulesTable)
        .where(
          and(
            eq(shiftSchedulesTable.facilityId, facilityId),
            eq(shiftSchedulesTable.month, month),
            publishedOnly
              ? eq(shiftSchedulesTable.status, "published")
              : ne(shiftSchedulesTable.status, "cancelled"),
            sql`exists (select 1 from ${shiftScheduleMembersTable} where ${shiftScheduleMembersTable.scheduleId} = ${shiftSchedulesTable.id} and ${shiftScheduleMembersTable.employeeId} = ${request.employeeId} and ${shiftScheduleMembersTable.releasedAt} is null)`,
          ),
        )
        .limit(1)
        .for("share")
    )[0] ?? null
  );
}

function adjacentMonths(month: string): string[] {
  const [year, number] = month.split("-").map(Number);
  return [-1, 1].map((offset) =>
    new Date(Date.UTC(year!, number! - 1 + offset, 1))
      .toISOString()
      .slice(0, 7),
  );
}

async function adjacentAssignments(
  tx: Transaction,
  input: SchedulePlanningInput,
  facilityId: number,
  employeeId: number,
  publishedOnly: boolean,
): Promise<AdjacentAssignment[]> {
  const rows = await tx
    .select({
      configuration: sql<
        Pick<ScheduleConfiguration, "shiftTypes" | "constraints">
      >`jsonb_build_object('shiftTypes', ${shiftSchedulesTable.configuration}->'shiftTypes', 'constraints', ${shiftSchedulesTable.configuration}->'constraints')`,
      assignments: sql<
        ShiftAssignment[]
      >`coalesce((select jsonb_agg(a.value) from jsonb_array_elements(${shiftSchedulesTable.assignments}) as a(value) where (a.value->>'employeeId')::integer = ${employeeId}), '[]'::jsonb)`,
    })
    .from(shiftSchedulesTable)
    .where(
      and(
        eq(shiftSchedulesTable.facilityId, facilityId),
        inArray(shiftSchedulesTable.month, adjacentMonths(input.month)),
        publishedOnly
          ? eq(shiftSchedulesTable.status, "published")
          : ne(shiftSchedulesTable.status, "cancelled"),
        sql`exists (select 1 from ${shiftScheduleMembersTable} where ${shiftScheduleMembersTable.scheduleId} = ${shiftSchedulesTable.id} and ${shiftScheduleMembersTable.employeeId} = ${employeeId} and ${shiftScheduleMembersTable.releasedAt} is null)`,
      ),
    )
    .limit(2)
    .for("share");
  return rows.flatMap((row) =>
    row.assignments.map((assignment) => {
      const shift = row.configuration.shiftTypes.find(
        (candidate) => candidate.code === assignment.shiftCode,
      );
      if (!shift) return failure(409, "invalid_adjacent_schedule");
      return {
        employeeId,
        date: assignment.date,
        startTime: shift.startTime,
        endTime: shift.endTime,
        minRestHours: row.configuration.constraints.minRestHours,
        maxConsecutiveDays: row.configuration.constraints.maxConsecutiveDays,
      };
    }),
  );
}

async function evaluate(
  tx: Transaction,
  request: ScheduleRequestEvaluationInput,
  facilityId: number,
  publishedOnly = false,
) {
  const schedule = await scheduleForRequest(
    tx,
    request,
    facilityId,
    publishedOnly,
  );
  const adjacent = schedule
    ? await adjacentAssignments(
        tx,
        planningInput(schedule),
        facilityId,
        request.employeeId,
        publishedOnly,
      )
    : [];
  const result = evaluateScheduleRequestFeasibility(
    request,
    schedule,
    adjacent,
  );
  return {
    feasibilityStatus: result.status,
    feasibilityReasonCodes: result.reasonCodes,
    evaluatedScheduleId: schedule?.id ?? null,
    evaluatedScheduleVersion: schedule?.rowVersion ?? null,
    evaluatedAt: new Date(),
  };
}

async function writeAudit(
  tx: Transaction,
  actor: RequestUser,
  row: ScheduleRequestRow,
  action: string,
  actionAr: string,
  change:
    "submitted" | "withdrawn" | "approved" | "rejected" | "approval_revoked",
  ipAddress?: string,
) {
  await tx.insert(auditLogsTable).values({
    userId: actor.id,
    facilityId: row.facilityId,
    userName: actor.name,
    userNameAr: actor.nameAr,
    action,
    actionAr,
    target: `Schedule request #${row.id}`,
    targetAr: `طلب جدول #${row.id}`,
    // Deliberately excludes free-form note, dates, employee name and shift.
    details: scheduleRequestAuditDetails(row),
    ipAddress: ipAddress ?? null,
  });
  await enqueueAutomationEvent(
    tx,
    scheduleRequestLifecycleEvent(
      row.facilityId,
      row.id,
      row.rowVersion,
      change,
    ),
  );
}

async function notifyReviewers(tx: Transaction, employee: RequestUser) {
  const candidates = await tx
    .select(requestUserColumns)
    .from(usersTable)
    // Eligibility is applied before LIMIT so unrelated managers cannot crowd
    // the employee's actual supervisor or department manager out.
    .where(reviewerScopeCondition(employee))
    .limit(200);
  let reviewers = candidates.filter((candidate) =>
    canReviewScheduleRequest(candidate, employee, employee.facilityId),
  );
  if (!reviewers.length) {
    reviewers = (
      await tx
        .select(requestUserColumns)
        .from(usersTable)
        .where(
          and(
            eq(usersTable.isActive, true),
            eq(usersTable.role, "system_admin"),
            ne(usersTable.id, employee.id),
          ),
        )
        .limit(20)
    ).filter((candidate) =>
      canReviewScheduleRequest(candidate, employee, employee.facilityId),
    );
  }
  if (!reviewers.length) return;
  await tx.insert(notificationsTable).values(
    reviewers.map((reviewer) => ({
      userId: reviewer.id,
      type: "system" as const,
      titleAr: "طلب جدول جديد",
      titleEn: "New schedule request",
      messageAr: "يوجد طلب جدول جديد بانتظار المراجعة.",
      messageEn: "A new schedule request is awaiting review.",
      employeeId: employee.id,
      isRead: false,
    })),
  );
}

async function notifyDecision(
  tx: Transaction,
  employeeId: number,
  status: "approved" | "rejected",
  revoked = false,
) {
  await tx.insert(notificationsTable).values({
    userId: employeeId,
    type: "system",
    titleAr: revoked
      ? "تم إلغاء الموافقة على طلبك"
      : status === "approved"
        ? "تمت الموافقة على طلبك"
        : "تم رفض طلبك",
    titleEn: revoked
      ? "Schedule request approval cancelled"
      : status === "approved"
        ? "Schedule request approved"
        : "Schedule request rejected",
    messageAr: "تم تحديث حالة طلب الجدول. افتح صفحة الطلبات للاطلاع.",
    messageEn:
      "Your schedule request status was updated. Open requests to review it.",
    employeeId,
    isRead: false,
  });
}

router.use("/schedule-requests", requireAuth, (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  next();
});

router.post(
  "/schedule-requests",
  rateLimit({
    name: "schedule-request-create",
    max: 20,
    windowMs: 60_000,
    keyGenerator: (req) => {
      const actor = getUser(req);
      return `facility:${actor.facilityId}:actor:${actor.id}`;
    },
  }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return failure(400, "invalid_schedule_request");
    const shapeIssue = validateScheduleRequestShape(parsed.data);
    if (shapeIssue) return failure(400, shapeIssue);
    const row = await db.transaction(async (tx) => {
      const actor = await lockedActor(tx, getUser(req), "update");
      const request = {
        employeeId: actor.id,
        kind: parsed.data.kind,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        shiftCode: parsed.data.shiftCode ?? null,
      } satisfies ScheduleRequestEvaluationInput;
      const overlapping = await tx
        .select({ id: scheduleRequestsTable.id })
        .from(scheduleRequestsTable)
        .where(
          and(
            eq(scheduleRequestsTable.employeeId, actor.id),
            eq(scheduleRequestsTable.status, "pending"),
            lte(scheduleRequestsTable.startDate, request.endDate),
            gte(scheduleRequestsTable.endDate, request.startDate),
          ),
        )
        .limit(1);
      if (overlapping.length) failure(409, "overlapping_schedule_request");
      // Employee probes must not reveal draft roster existence or coverage.
      const feasibility = await evaluate(tx, request, actor.facilityId, true);
      const saved = (
        await tx
          .insert(scheduleRequestsTable)
          .values({
            ...request,
            facilityId: actor.facilityId,
            note: parsed.data.note?.trim() ?? null,
            ...feasibility,
          })
          .returning()
      )[0];
      if (!saved) throw new Error("Schedule request insert returned no row");
      await writeAudit(
        tx,
        actor,
        saved,
        "Submitted schedule request",
        "تقديم طلب جدول",
        "submitted",
        req.ip,
      );
      await notifyReviewers(tx, actor);
      return { saved, actor };
    });
    res
      .status(201)
      .json(serializeScheduleRequest(row.saved, row.actor, "employee"));
  },
);

router.get("/schedule-requests/mine", async (req, res) => {
  const result = await db.transaction(async (tx) => {
    const actor = await lockedActor(tx, getUser(req), "share");
    const rows = await tx
      .select()
      .from(scheduleRequestsTable)
      .where(eq(scheduleRequestsTable.employeeId, actor.id))
      .orderBy(desc(scheduleRequestsTable.createdAt))
      .limit(100);
    return rows.map((row) => serializeScheduleRequest(row, actor, "employee"));
  });
  res.json(result);
});

router.get(
  "/schedule-requests/review",
  requireRole(...MANAGER_ROLES),
  async (req, res) => {
    const parsed = reviewQuery.safeParse(req.query);
    if (!parsed.success) return failure(400, "invalid_schedule_request_filter");
    const result = await db.transaction(async (tx) => {
      const actor = await lockedActor(tx, getUser(req), "share", true);
      const rows = await tx
        .select({
          request: scheduleRequestsTable,
          employee: requestUserColumns,
        })
        .from(scheduleRequestsTable)
        .innerJoin(
          usersTable,
          eq(usersTable.id, scheduleRequestsTable.employeeId),
        )
        .where(
          and(
            reviewScopeCondition(actor),
            parsed.data.status
              ? eq(scheduleRequestsTable.status, parsed.data.status)
              : undefined,
          ),
        )
        .orderBy(desc(scheduleRequestsTable.createdAt))
        // Scope is part of the SQL before LIMIT, so another tenant's volume
        // cannot crowd authorized rows out of this bounded result.
        .limit(100);
      return rows
        .filter(({ request, employee }) =>
          canReviewScheduleRequest(actor, employee, request.facilityId),
        )
        .map(({ request, employee }) =>
          serializeScheduleRequest(request, employee, "review"),
        );
    });
    res.json(result);
  },
);

router.post("/schedule-requests/:id/withdraw", async (req, res) => {
  const id = idFrom(req);
  if (
    !req.body ||
    typeof req.body !== "object" ||
    !Object.prototype.hasOwnProperty.call(req.body, "expectedVersion")
  )
    failure(428, "expected_version_required");
  const parsed = withdrawBody.safeParse(req.body);
  if (!parsed.success) return failure(400, "invalid_schedule_request_update");
  const result = await db.transaction(async (tx) => {
    const actor = await lockedActor(tx, getUser(req), "update");
    const current = (
      await tx
        .select()
        .from(scheduleRequestsTable)
        .where(
          and(
            eq(scheduleRequestsTable.id, id),
            eq(scheduleRequestsTable.employeeId, actor.id),
          ),
        )
        .for("update")
    )[0];
    if (!current) failure(404, "schedule_request_not_found");
    if (current.rowVersion !== parsed.data.expectedVersion)
      failure(409, "schedule_request_version_conflict");
    if (current.status !== "pending")
      failure(409, "schedule_request_not_pending");
    if (current.evaluatedScheduleId != null)
      await tx
        .select({ id: shiftSchedulesTable.id })
        .from(shiftSchedulesTable)
        .where(eq(shiftSchedulesTable.id, current.evaluatedScheduleId))
        .for("share");
    const saved = (
      await tx
        .update(scheduleRequestsTable)
        .set({
          status: "withdrawn",
          rowVersion: current.rowVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(scheduleRequestsTable.id, id),
            eq(scheduleRequestsTable.rowVersion, parsed.data.expectedVersion),
            eq(scheduleRequestsTable.status, "pending"),
          ),
        )
        .returning()
    )[0];
    if (!saved) failure(409, "schedule_request_version_conflict");
    await writeAudit(
      tx,
      actor,
      saved,
      "Withdrew schedule request",
      "سحب طلب جدول",
      "withdrawn",
      req.ip,
    );
    return { saved, actor };
  });
  res.json(serializeScheduleRequest(result.saved, result.actor, "employee"));
});

router.post(
  "/schedule-requests/:id/decision",
  requireRole(...MANAGER_ROLES),
  async (req, res) => {
    const id = idFrom(req);
    if (
      !req.body ||
      typeof req.body !== "object" ||
      !Object.prototype.hasOwnProperty.call(req.body, "expectedVersion")
    )
      failure(428, "expected_version_required");
    const parsed = decisionBody.safeParse(req.body);
    if (!parsed.success)
      return failure(400, "invalid_schedule_request_decision");
    const initial = (
      await db
        .select({
          request: {
            employeeId: scheduleRequestsTable.employeeId,
            facilityId: scheduleRequestsTable.facilityId,
          },
        })
        .from(scheduleRequestsTable)
        .innerJoin(
          usersTable,
          eq(usersTable.id, scheduleRequestsTable.employeeId),
        )
        .where(
          and(
            eq(scheduleRequestsTable.id, id),
            reviewScopeCondition(getUser(req)),
          ),
        )
        .limit(1)
    )[0];
    if (!initial) failure(404, "schedule_request_not_found");
    const result = await db.transaction(async (tx) => {
      const { actor, target } = await lockedActorAndTarget(
        tx,
        getUser(req),
        initial.request.employeeId,
      );
      if (!canReviewScheduleRequest(actor, target, initial.request.facilityId))
        failure(404, "schedule_request_not_found");
      const current = (
        await tx
          .select()
          .from(scheduleRequestsTable)
          .where(eq(scheduleRequestsTable.id, id))
          .for("update")
      )[0];
      if (
        !current ||
        current.employeeId !== target.id ||
        !canReviewScheduleRequest(actor, target, current.facilityId)
      )
        failure(404, "schedule_request_not_found");
      const decisionIssue = scheduleRequestDecisionIssue(
        current,
        parsed.data.expectedVersion,
        parsed.data.decision,
      );
      if (decisionIssue) failure(409, decisionIssue);
      const decisionMode = scheduleRequestDecisionMode(
        current.status,
        parsed.data.decision,
      )!;
      if (parsed.data.decision === "approved") {
        // The target user row is already locked above, serializing approvals
        // for this employee. Lock matching durable requests in stable order
        // before the schedule lock so two overlapping approvals cannot race.
        const approvedRequests = await tx
          .select()
          .from(scheduleRequestsTable)
          .where(
            and(
              eq(scheduleRequestsTable.employeeId, current.employeeId),
              eq(scheduleRequestsTable.status, "approved"),
              ne(scheduleRequestsTable.id, current.id),
              lte(scheduleRequestsTable.startDate, current.endDate),
              gte(scheduleRequestsTable.endDate, current.startDate),
            ),
          )
          .orderBy(asc(scheduleRequestsTable.id))
          .for("share");
        if (hasConflictingApprovedScheduleRequest(current, approvedRequests))
          failure(409, "conflicting_approved_schedule_request");
      }
      const feasibility = await evaluate(
        tx,
        evaluationInput(current),
        current.facilityId,
      );
      const now = new Date();
      const saved = (
        await tx
          .update(scheduleRequestsTable)
          .set({
            status: parsed.data.decision,
            rowVersion: current.rowVersion + 1,
            ...feasibility,
            decidedBy: actor.id,
            decidedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(scheduleRequestsTable.id, id),
              eq(scheduleRequestsTable.rowVersion, parsed.data.expectedVersion),
              eq(scheduleRequestsTable.status, current.status),
            ),
          )
          .returning()
      )[0];
      if (!saved) failure(409, "schedule_request_version_conflict");
      await writeAudit(
        tx,
        actor,
        saved,
        decisionMode === "revocation"
          ? "Revoked approved schedule request"
          : parsed.data.decision === "approved"
            ? "Approved schedule request"
            : "Rejected schedule request",
        decisionMode === "revocation"
          ? "إلغاء موافقة طلب جدول"
          : parsed.data.decision === "approved"
            ? "الموافقة على طلب جدول"
            : "رفض طلب جدول",
        decisionMode === "revocation"
          ? "approval_revoked"
          : parsed.data.decision,
        req.ip,
      );
      await notifyDecision(
        tx,
        target.id,
        parsed.data.decision,
        decisionMode === "revocation",
      );
      return { saved, target };
    });
    res.json(serializeScheduleRequest(result.saved, result.target, "review"));
  },
);

router.use(
  "/schedule-requests",
  (
    error: unknown,
    _req: Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    if (error instanceof RequestError) {
      res.status(error.status).json({ message: error.code, code: error.code });
      return;
    }
    next(error);
  },
);

export default router;
