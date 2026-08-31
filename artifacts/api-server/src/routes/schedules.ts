import { Router, type IRouter, type Request, type Response } from "express";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
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
  auditLogsTable,
  type User,
  type ShiftScheduleRow,
  type ScheduleConfiguration,
} from "@workspace/db";
import {
  CreateScheduleBody,
  UpdateScheduleBody,
  PublishScheduleBody,
  ReopenScheduleBody,
  CancelScheduleBody,
} from "@workspace/api-zod";
import { getUser, requireAuth, requireRole, MANAGER_ROLES } from "../lib/auth";
import { getScopedUsers } from "../lib/helpers";
import { isFreshActiveSessionActor } from "../lib/sessionFreshness";
import { rateLimit } from "../lib/rateLimit";
import {
  generateSchedule,
  validateSchedule,
  validatePlanningInput,
  type SchedulePlanningInput,
  type ShiftAssignment,
  type AdjacentAssignment,
} from "../lib/shiftScheduling";

const router: IRouter = Router();
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const monthPattern = /^20\d{2}-(0[1-9]|1[0-2])$/;
const createBody = CreateScheduleBody.strict().extend({
  shiftTypes: CreateScheduleBody.shape.shiftTypes.element
    .strict()
    .array()
    .min(1)
    .max(6),
  constraints: CreateScheduleBody.shape.constraints.strict(),
  unavailability: CreateScheduleBody.shape.unavailability.element
    .strict()
    .array()
    .max(6200),
});
const updateBody = UpdateScheduleBody.strict().extend({
  assignments: UpdateScheduleBody.shape.assignments.element
    .strict()
    .array()
    .max(6200),
});

class ScheduleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function failure(status: number, code: string): never {
  throw new ScheduleError(status, code);
}
function idFrom(req: Request): number {
  const value = String(req.params.id);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    failure(400, "invalid_schedule_id");
  return Number(value);
}
function requestedMonth(req: Request, required = false): string {
  const month =
    req.query.month ??
    (required
      ? ""
      : new Date(Date.now() + 3 * 60 * 60_000).toISOString().slice(0, 7));
  if (typeof month !== "string" || !monthPattern.test(month))
    failure(400, "invalid_month");
  return month as string;
}
function planningInput(row: ShiftScheduleRow): SchedulePlanningInput {
  return { ...row.configuration, title: row.title, month: row.month };
}
function serialize(row: ShiftScheduleRow) {
  const input = planningInput(row);
  const result = validateSchedule(input, row.assignments);
  return {
    id: row.id,
    title: row.title,
    month: row.month,
    facilityId: row.facilityId,
    status: row.status,
    version: row.rowVersion,
    ...row.configuration,
    assignments: row.assignments,
    shortages: result.shortages,
    warnings: result.warnings,
    employeeCount: row.configuration.employeeIds.length,
    shortageCount: result.shortages.reduce(
      (sum, item) => sum + item.required - item.assigned,
      0,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function summary(row: ShiftScheduleRow) {
  const {
    id,
    title,
    month,
    status,
    version,
    employeeCount,
    shortageCount,
    createdAt,
    updatedAt,
  } = serialize(row);
  return {
    id,
    title,
    month,
    status,
    version,
    employeeCount,
    shortageCount,
    createdAt,
    updatedAt,
  };
}
type TeamScheduleParticipant = {
  employeeId: number;
  name: string;
  nameAr: string;
};
function publicShiftTypes(row: ShiftScheduleRow) {
  return row.configuration.shiftTypes.map((shift) => ({
    code: shift.code,
    label: shift.label,
    labelAr: shift.labelAr,
    startTime: shift.startTime,
    endTime: shift.endTime,
  }));
}
function publicAssignments(assignments: ShiftAssignment[]) {
  return assignments.map((assignment) => ({
    employeeId: assignment.employeeId,
    date: assignment.date,
    shiftCode: assignment.shiftCode,
  }));
}
/** The personal employee view is also projected from stored JSON fail-safely. */
export function serializePublishedPersonalSchedule(
  row: ShiftScheduleRow,
  employeeId: number,
) {
  if (row.status !== "published") return null;
  return {
    scheduleId: row.id,
    title: row.title,
    month: row.month,
    shiftTypes: publicShiftTypes(row),
    assignments: publicAssignments(
      row.assignments.filter((item) => item.employeeId === employeeId),
    ),
  };
}
/**
 * Builds the intentionally minimal employee view. Returning null is fail-closed:
 * all configured employees and assignment owners must be among the scoped
 * participants selected by the caller's current facility query.
 */
export function serializePublishedTeamSchedule(
  row: ShiftScheduleRow,
  participants: TeamScheduleParticipant[],
) {
  const participantIds = new Set(
    participants.map((participant) => participant.employeeId),
  );
  const configuredIds = new Set(row.configuration.employeeIds);
  if (
    row.status !== "published" ||
    participantIds.size !== participants.length ||
    configuredIds.size !== row.configuration.employeeIds.length ||
    participants.length !== row.configuration.employeeIds.length ||
    [...configuredIds].some((id) => !participantIds.has(id)) ||
    row.assignments.some(
      (assignment) => !participantIds.has(assignment.employeeId),
    )
  )
    return null;
  return {
    scheduleId: row.id,
    title: row.title,
    month: row.month,
    shiftTypes: publicShiftTypes(row),
    participants,
    assignments: publicAssignments(row.assignments),
  };
}
function currentUserScope(actor: User): SQL {
  if (actor.role === "system_admin") return sql`true`;
  const facility = eq(usersTable.facilityId, actor.facilityId);
  if (actor.role === "hospital_admin") return facility;
  const own = eq(usersTable.id, actor.id);
  if (actor.role === "department_manager")
    return and(
      facility,
      or(
        own,
        actor.departmentId == null
          ? sql`false`
          : eq(usersTable.departmentId, actor.departmentId),
      ),
    )!;
  if (actor.role === "supervisor")
    return and(facility, or(own, eq(usersTable.supervisorId, actor.id)))!;
  return and(facility, own)!;
}
/** SQL checks every current participant, never returns a partially scoped roster. */
function completeRosterScope(actor: User): SQL {
  return and(
    actor.role === "system_admin"
      ? sql`true`
      : eq(shiftSchedulesTable.facilityId, actor.facilityId),
    sql`not exists (select 1 from ${shiftScheduleMembersTable} inner join ${usersTable} on ${usersTable.id} = ${shiftScheduleMembersTable.employeeId} where ${shiftScheduleMembersTable.scheduleId} = ${shiftSchedulesTable.id} and (${currentUserScope(actor)}) is not true)`,
  )!;
}
async function lockedActor(
  tx: Transaction,
  requestUser: User,
  manager: boolean,
) {
  const actor = (
    await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, requestUser.id))
      .for("share")
  )[0];
  if (!isFreshActiveSessionActor(actor, requestUser))
    failure(401, "unauthorized");
  if (manager && !MANAGER_ROLES.includes(actor.role)) failure(403, "forbidden");
  return actor;
}
async function lockParticipants(
  tx: Transaction,
  requestUser: User,
  employeeIds: number[],
  facilityId?: number,
  withdrawal = false,
) {
  // One stable row-lock order serializes all writes involving each employee,
  // including different months, while preventing organizational scope races.
  const ids = [...new Set([requestUser.id, ...employeeIds])].sort(
    (a, b) => a - b,
  );
  const rows = await tx
    .select()
    .from(usersTable)
    .where(inArray(usersTable.id, ids))
    .orderBy(asc(usersTable.id))
    .for("update");
  const actor = rows.find((row) => row.id === requestUser.id);
  if (!isFreshActiveSessionActor(actor, requestUser))
    failure(401, "unauthorized");
  if (!MANAGER_ROLES.includes(actor.role)) failure(403, "forbidden");
  const employees = employeeIds.map((id) => rows.find((row) => row.id === id));
  const scopedIds = new Set(
    (await getScopedUsers(actor, tx, employeeIds)).map((row) => row.id),
  );
  if (employees.some((row) => !row || !scopedIds.has(row.id)))
    failure(403, "participant_scope_denied");
  if (!withdrawal && employees.some((row) => !row!.isActive))
    failure(409, "inactive_participant");
  const selectedFacility = facilityId ?? employees[0]!.facilityId;
  if (
    !withdrawal &&
    employees.some((row) => row!.facilityId !== selectedFacility)
  )
    failure(409, "participant_facility_changed");
  return { actor, facilityId: selectedFacility };
}
function adjacentMonths(month: string): string[] {
  const [year, number] = month.split("-").map(Number);
  return [-1, 1].map((offset) =>
    new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7),
  );
}
async function adjacentAssignments(
  tx: Transaction,
  input: SchedulePlanningInput,
): Promise<AdjacentAssignment[]> {
  // Internal constraint evaluation only: neighboring workforce records never
  // enter the response or audit. Membership bounds this to 2 rosters/employee.
  const rows = await tx
    .select({
      configuration: sql<
        Pick<ScheduleConfiguration, "shiftTypes" | "constraints">
      >`jsonb_build_object('shiftTypes', ${shiftSchedulesTable.configuration}->'shiftTypes', 'constraints', ${shiftSchedulesTable.configuration}->'constraints')`,
      assignments: sql<
        ShiftAssignment[]
      >`coalesce((select jsonb_agg(a.value) from jsonb_array_elements(${shiftSchedulesTable.assignments}) as a(value) where ${inArray(sql<number>`(a.value->>'employeeId')::integer`, input.employeeIds)}), '[]'::jsonb)`,
    })
    .from(shiftSchedulesTable)
    .where(
      and(
        inArray(shiftSchedulesTable.month, adjacentMonths(input.month)),
        ne(shiftSchedulesTable.status, "cancelled"),
        sql`exists (select 1 from ${shiftScheduleMembersTable} where ${shiftScheduleMembersTable.scheduleId} = ${shiftSchedulesTable.id} and ${inArray(shiftScheduleMembersTable.employeeId, input.employeeIds)})`,
      ),
    )
    .limit(input.employeeIds.length * 2);
  const employeeIds = new Set(input.employeeIds);
  return rows.flatMap((row) =>
    row.assignments
      .filter((item) => employeeIds.has(item.employeeId))
      .map((item) => {
        const shift = row.configuration.shiftTypes.find(
          (candidate) => candidate.code === item.shiftCode,
        );
        if (!shift) return failure(409, "invalid_adjacent_schedule");
        return {
          employeeId: item.employeeId,
          date: item.date,
          startTime: shift.startTime,
          endTime: shift.endTime,
          minRestHours: row.configuration.constraints.minRestHours,
          maxConsecutiveDays: row.configuration.constraints.maxConsecutiveDays,
        };
      }),
  );
}
async function audit(
  tx: Transaction,
  actor: User,
  row: ShiftScheduleRow,
  action: string,
  actionAr: string,
  ipAddress?: string,
) {
  await tx.insert(auditLogsTable).values({
    userId: actor.id,
    facilityId: row.facilityId,
    userName: actor.name,
    userNameAr: actor.nameAr,
    action,
    actionAr,
    target: `Schedule #${row.id}`,
    targetAr: `جدول #${row.id}`,
    // No employee names/IDs, roster title, assignments or availability payload.
    details: JSON.stringify({
      scheduleId: row.id,
      month: row.month,
      version: row.rowVersion,
      status: row.status,
      employeeCount: row.configuration.employeeIds.length,
    }),
    ipAddress: ipAddress ?? null,
  });
}
function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let i = 0; i < 4 && current && typeof current === "object"; i++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

router.use("/schedules", requireAuth, (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  next();
});
router.get("/schedules/mine", async (req, res) => {
  const month = requestedMonth(req, true);
  const result = await db.transaction(async (tx) => {
    const actor = await lockedActor(tx, getUser(req), false);
    const rows = await tx
      .select()
      .from(shiftSchedulesTable)
      .where(
        and(
          eq(shiftSchedulesTable.month, month),
          eq(shiftSchedulesTable.status, "published"),
          eq(shiftSchedulesTable.facilityId, actor.facilityId),
          sql`exists (select 1 from ${shiftScheduleMembersTable} where ${shiftScheduleMembersTable.scheduleId} = ${shiftSchedulesTable.id} and ${shiftScheduleMembersTable.employeeId} = ${actor.id} and ${shiftScheduleMembersTable.releasedAt} is null)`,
        ),
      )
      .limit(1);
    return rows.flatMap((row) => {
      const schedule = serializePublishedPersonalSchedule(row, actor.id);
      return schedule ? [schedule] : [];
    });
  });
  res.json(result);
});

router.get("/schedules/team", async (req, res) => {
  const month = requestedMonth(req, true);
  const result = await db.transaction(async (tx) => {
    const actor = await lockedActor(tx, getUser(req), false);
    const rows = await tx
      .select()
      .from(shiftSchedulesTable)
      .where(
        and(
          eq(shiftSchedulesTable.month, month),
          eq(shiftSchedulesTable.status, "published"),
          eq(shiftSchedulesTable.facilityId, actor.facilityId),
          sql`exists (select 1 from ${shiftScheduleMembersTable} where ${shiftScheduleMembersTable.scheduleId} = ${shiftSchedulesTable.id} and ${shiftScheduleMembersTable.employeeId} = ${actor.id} and ${shiftScheduleMembersTable.releasedAt} is null)`,
          // A transferred or inactive participant hides the entire team
          // roster. Never expose a partial roster or cross-facility shifts.
          sql`not exists (select 1 from ${shiftScheduleMembersTable} inner join ${usersTable} on ${usersTable.id} = ${shiftScheduleMembersTable.employeeId} where ${shiftScheduleMembersTable.scheduleId} = ${shiftSchedulesTable.id} and (${usersTable.facilityId} is distinct from ${actor.facilityId} or ${usersTable.isActive} is not true))`,
        ),
      )
      .limit(1);
    const teamSchedules: NonNullable<
      ReturnType<typeof serializePublishedTeamSchedule>
    >[] = [];
    for (const row of rows) {
      const participants = await tx
        .select({
          employeeId: usersTable.id,
          name: usersTable.name,
          nameAr: usersTable.nameAr,
        })
        .from(shiftScheduleMembersTable)
        .innerJoin(
          usersTable,
          eq(usersTable.id, shiftScheduleMembersTable.employeeId),
        )
        .where(
          and(
            eq(shiftScheduleMembersTable.scheduleId, row.id),
            isNull(shiftScheduleMembersTable.releasedAt),
            eq(usersTable.facilityId, actor.facilityId),
            eq(usersTable.isActive, true),
          ),
        )
        .orderBy(asc(usersTable.id));
      const teamSchedule = serializePublishedTeamSchedule(row, participants);
      if (teamSchedule) teamSchedules.push(teamSchedule);
    }
    return teamSchedules;
  });
  res.json(result);
});

router.get("/schedules", requireRole(...MANAGER_ROLES), async (req, res) => {
  const month = requestedMonth(req);
  const result = await db.transaction(async (tx) => {
    const actor = await lockedActor(tx, getUser(req), true);
    const rows = await tx
      .select()
      .from(shiftSchedulesTable)
      .where(
        and(
          eq(shiftSchedulesTable.month, month),
          ne(shiftSchedulesTable.status, "cancelled"),
          completeRosterScope(actor),
          sql`exists (select 1 from ${shiftScheduleMembersTable} where ${shiftScheduleMembersTable.scheduleId} = ${shiftSchedulesTable.id})`,
        ),
      )
      .orderBy(desc(shiftSchedulesTable.createdAt))
      .limit(100);
    return rows.map(summary);
  });
  res.json(result);
});

router.post(
  "/schedules",
  requireRole(...MANAGER_ROLES),
  rateLimit({ name: "schedule-generate", max: 20, windowMs: 60_000 }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return failure(400, "invalid_schedule_configuration");
    const input = parsed.data;
    const issues = validatePlanningInput(input);
    if (issues.length) return failure(400, issues[0]);
    const row = await db.transaction(async (tx) => {
      const { actor, facilityId } = await lockParticipants(
        tx,
        getUser(req),
        input.employeeIds,
      );
      const existing = await tx
        .select({ id: shiftScheduleMembersTable.id })
        .from(shiftScheduleMembersTable)
        .where(
          and(
            eq(shiftScheduleMembersTable.month, input.month),
            isNull(shiftScheduleMembersTable.releasedAt),
            inArray(shiftScheduleMembersTable.employeeId, input.employeeIds),
          ),
        )
        .limit(1);
      if (existing.length) failure(409, "employee_month_already_scheduled");
      const generated = generateSchedule(
        input,
        await adjacentAssignments(tx, input),
      );
      const { title, month, ...configuration } = input;
      const saved = (
        await tx
          .insert(shiftSchedulesTable)
          .values({
            title: title.trim(),
            month,
            facilityId,
            configuration,
            assignments: generated.assignments,
            createdBy: actor.id,
            updatedBy: actor.id,
          })
          .returning()
      )[0];
      if (!saved) throw new Error("Schedule insert returned no row");
      await tx.insert(shiftScheduleMembersTable).values(
        input.employeeIds.map((employeeId) => ({
          scheduleId: saved.id,
          employeeId,
          month,
        })),
      );
      await audit(
        tx,
        actor,
        saved,
        "Created shift schedule",
        "إنشاء جدول مناوبات",
        req.ip,
      );
      return saved;
    });
    res.status(201).json(serialize(row));
  },
);

router.get(
  "/schedules/:id",
  requireRole(...MANAGER_ROLES),
  async (req, res) => {
    const id = idFrom(req);
    const row = await db.transaction(async (tx) => {
      const actor = await lockedActor(tx, getUser(req), true);
      const saved = (
        await tx
          .select()
          .from(shiftSchedulesTable)
          .where(
            and(eq(shiftSchedulesTable.id, id), completeRosterScope(actor)),
          )
          .limit(1)
      )[0];
      if (!saved) failure(404, "schedule_not_found");
      return saved;
    });
    res.json(serialize(row));
  },
);

async function mutate(
  req: Request,
  res: Response,
  operation: "edit" | "publish" | "reopen" | "cancel",
) {
  const id = idFrom(req);
  if (
    !req.body ||
    typeof req.body !== "object" ||
    !Object.prototype.hasOwnProperty.call(req.body, "expectedVersion")
  )
    failure(428, "expected_version_required");
  const parsed = (
    operation === "edit"
      ? updateBody
      : operation === "publish"
        ? PublishScheduleBody.strict()
        : operation === "cancel"
          ? CancelScheduleBody.strict()
          : ReopenScheduleBody.strict()
  ).safeParse(req.body);
  if (!parsed.success) return failure(400, "invalid_schedule_update");
  const expectedVersion = parsed.data.expectedVersion;
  const row = await db.transaction(async (tx) => {
    const initial = (
      await tx
        .select()
        .from(shiftSchedulesTable)
        .where(
          and(
            eq(shiftSchedulesTable.id, id),
            completeRosterScope(getUser(req)),
          ),
        )
        .limit(1)
    )[0];
    if (!initial) failure(404, "schedule_not_found");
    const { actor } = await lockParticipants(
      tx,
      getUser(req),
      initial.configuration.employeeIds,
      initial.facilityId,
      operation === "cancel" || operation === "reopen",
    );
    const current = (
      await tx
        .select()
        .from(shiftSchedulesTable)
        .where(and(eq(shiftSchedulesTable.id, id), completeRosterScope(actor)))
        .for("update")
    )[0];
    if (!current) failure(404, "schedule_not_found");
    if (current.rowVersion !== expectedVersion)
      failure(409, "schedule_version_conflict");
    if (current.status !== (operation === "reopen" ? "published" : "draft"))
      failure(409, "invalid_schedule_status");
    const assignments: ShiftAssignment[] =
      operation === "edit"
        ? updateBody.parse(req.body).assignments
        : current.assignments;
    if (operation === "edit" || operation === "publish") {
      const input = planningInput(current);
      const result = validateSchedule(
        input,
        assignments,
        await adjacentAssignments(tx, input),
      );
      if (!result.valid)
        failure(
          operation === "publish" ? 409 : 400,
          result.issues[0] ?? "invalid_assignments",
        );
      if (operation === "publish" && result.shortages.length)
        failure(409, "coverage_shortage");
    }
    const saved = (
      await tx
        .update(shiftSchedulesTable)
        .set({
          assignments,
          status:
            operation === "publish"
              ? "published"
              : operation === "cancel"
                ? "cancelled"
                : "draft",
          rowVersion: current.rowVersion + 1,
          updatedBy: actor.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(shiftSchedulesTable.id, id),
            eq(shiftSchedulesTable.rowVersion, expectedVersion),
          ),
        )
        .returning()
    )[0];
    if (!saved) failure(409, "schedule_version_conflict");
    if (operation === "cancel")
      await tx
        .update(shiftScheduleMembersTable)
        .set({ releasedAt: new Date() })
        .where(eq(shiftScheduleMembersTable.scheduleId, id));
    const actions = {
      edit: ["Edited shift schedule", "تعديل جدول مناوبات"],
      publish: ["Published shift schedule", "نشر جدول مناوبات"],
      reopen: ["Reopened shift schedule", "إعادة فتح جدول مناوبات"],
      cancel: ["Cancelled shift schedule", "إلغاء جدول مناوبات"],
    } as const;
    await audit(
      tx,
      actor,
      saved,
      actions[operation][0],
      actions[operation][1],
      req.ip,
    );
    return saved;
  });
  res.json(serialize(row));
}
router.patch("/schedules/:id", requireRole(...MANAGER_ROLES), (req, res) =>
  mutate(req, res, "edit"),
);
router.post(
  "/schedules/:id/publish",
  requireRole(...MANAGER_ROLES),
  (req, res) => mutate(req, res, "publish"),
);
router.post(
  "/schedules/:id/reopen",
  requireRole(...MANAGER_ROLES),
  (req, res) => mutate(req, res, "reopen"),
);
router.post(
  "/schedules/:id/cancel",
  requireRole(...MANAGER_ROLES),
  (req, res) => mutate(req, res, "cancel"),
);
router.use(
  "/schedules",
  (
    error: unknown,
    _req: Request,
    res: Response,
    next: import("express").NextFunction,
  ) => {
    if (error instanceof ScheduleError) {
      res.status(error.status).json({ message: error.code, code: error.code });
      return;
    }
    if (isUniqueViolation(error)) {
      res.status(409).json({
        message: "employee_month_already_scheduled",
        code: "employee_month_already_scheduled",
      });
      return;
    }
    next(error);
  },
);
export default router;
