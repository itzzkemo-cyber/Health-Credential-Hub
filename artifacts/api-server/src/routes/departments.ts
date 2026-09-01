import { Router, type IRouter } from "express";
import {
  db,
  auditLogsTable,
  credentialPoliciesTable,
  departmentsTable,
  usersTable,
  type Department,
  type User,
} from "@workspace/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  BatchCreateDepartmentsBody,
  CreateDepartmentBody,
} from "@workspace/api-zod";
import { requireAuth, requireRole, getUser, ADMIN_ROLES } from "../lib/auth";
import { isFreshActiveSessionActor } from "../lib/sessionFreshness";
import {
  getCredentialsFor,
  getPolicies,
  computeEmployeeStats,
  getScopedUsers,
} from "../lib/helpers";

const router: IRouter = Router();
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const createDepartmentBody = CreateDepartmentBody.strict();
const batchCreateDepartmentsBody = BatchCreateDepartmentsBody.strict().extend({
  departments: BatchCreateDepartmentsBody.shape.departments.element
    .strict()
    .array()
    .min(1)
    .max(50),
});

function serializeDepartment(department: Department) {
  return {
    id: department.id,
    name: department.name,
    nameAr: department.nameAr,
    facilityId: department.facilityId,
    headId: department.headId,
    createdAt: department.createdAt.toISOString(),
  };
}

function isCurrentAdmin(actor: User | undefined): actor is User {
  return Boolean(
    actor?.isActive &&
    ADMIN_ROLES.includes(actor.role as (typeof ADMIN_ROLES)[number]),
  );
}

function normalizedDepartmentName(value: string): string {
  return value.trim().toLowerCase();
}

async function lockDepartmentNames(tx: Transaction, facilityId: number) {
  // Serialize department-name creation within one facility. Both single and
  // batch creation take the same actor/user locks before this advisory lock,
  // so the ordering is stable and concurrent requests cannot create the same
  // normalized name between the conflict check and insert.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`health-credential:departments:${facilityId}`}, 0))`,
  );
  return tx
    .select({
      id: departmentsTable.id,
      name: departmentsTable.name,
      nameAr: departmentsTable.nameAr,
    })
    .from(departmentsTable)
    .where(
      and(
        eq(departmentsTable.facilityId, facilityId),
        isNull(departmentsTable.deletedAt),
      ),
    );
}

function departmentNameSets(
  departments: ReadonlyArray<{ name: string; nameAr: string }>,
) {
  return {
    names: new Set(
      departments.map((department) =>
        normalizedDepartmentName(department.name),
      ),
    ),
    namesAr: new Set(
      departments.map((department) =>
        normalizedDepartmentName(department.nameAr),
      ),
    ),
  };
}

function hasDepartmentNameConflict(
  names: Set<string>,
  namesAr: Set<string>,
  department: { name: string; nameAr: string },
): boolean {
  return (
    names.has(normalizedDepartmentName(department.name)) ||
    namesAr.has(normalizedDepartmentName(department.nameAr))
  );
}

function reserveDepartmentName(
  names: Set<string>,
  namesAr: Set<string>,
  department: { name: string; nameAr: string },
) {
  names.add(normalizedDepartmentName(department.name));
  namesAr.add(normalizedDepartmentName(department.nameAr));
}

function departmentAuditValues(
  actor: User,
  action: string,
  actionAr: string,
  department: Department,
  ipAddress: string | undefined,
  details: string | null = null,
) {
  return {
    userId: actor.id,
    facilityId: department.facilityId,
    userName: actor.name,
    userNameAr: actor.nameAr,
    action,
    actionAr,
    target: department.name,
    targetAr: department.nameAr,
    details,
    ipAddress: ipAddress ?? null,
  };
}

router.use("/departments", requireAuth);

router.get("/departments", async (req, res) => {
  const user = getUser(req);
  let facilityId = user.facilityId;
  if (user.role === "system_admin" && req.query.facilityId != null) {
    const requestedFacilityId =
      typeof req.query.facilityId === "string"
        ? Number(req.query.facilityId)
        : Number.NaN;
    if (!Number.isSafeInteger(requestedFacilityId) || requestedFacilityId < 1) {
      res.status(400).json({ message: "A valid facilityId is required" });
      return;
    }
    facilityId = requestedFacilityId;
  }
  const departments = await db
    .select()
    .from(departmentsTable)
    .where(
      and(
        eq(departmentsTable.facilityId, facilityId),
        isNull(departmentsTable.deletedAt),
      ),
    );
  const scopedUsers = (await getScopedUsers(user)).filter(
    (candidate) => candidate.facilityId === facilityId,
  );
  const creds = await getCredentialsFor(scopedUsers.map((u) => u.id));
  const policies = await getPolicies(facilityId);

  const result = departments.map((d) => {
    const members = scopedUsers.filter(
      (u) => u.departmentId === d.id && u.isActive,
    );
    let expiredCount = 0;
    let expiringCount = 0;
    let rateSum = 0;
    for (const m of members) {
      const s = computeEmployeeStats(m, creds, policies);
      expiredCount += s.expiredCount;
      expiringCount += s.expiringCount;
      rateSum += s.complianceRate;
    }
    return {
      ...serializeDepartment(d),
      employeeCount: members.length,
      complianceRate:
        members.length === 0 ? 100 : Math.round(rateSum / members.length),
      expiredCount,
      expiringCount,
    };
  });
  res.json(result);
});

router.post("/departments", requireRole(...ADMIN_ROLES), async (req, res) => {
  const requestUser = getUser(req);
  const parsed = createDepartmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid department" });
    return;
  }
  const name = parsed.data.name.trim();
  const nameAr = parsed.data.nameAr.trim();
  if (!name || !nameAr) {
    res.status(400).json({ message: "name and nameAr are required" });
    return;
  }
  const headId = parsed.data.headId == null ? null : parsed.data.headId;
  if (headId != null && (!Number.isSafeInteger(headId) || headId < 1)) {
    res.status(400).json({
      message: "Department head not found in this facility",
    });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const userIds = [...new Set([requestUser.id, ...(headId ? [headId] : [])])];
    const lockedUsers = await tx
      .select()
      .from(usersTable)
      .where(inArray(usersTable.id, userIds))
      .orderBy(usersTable.id)
      .for("share");
    const actor = lockedUsers.find(
      (candidate) => candidate.id === requestUser.id,
    );
    if (!isFreshActiveSessionActor(actor, requestUser)) {
      return { kind: "unauthorized" as const };
    }
    if (!isCurrentAdmin(actor)) return { kind: "forbidden" as const };
    const head =
      headId == null
        ? null
        : lockedUsers.find(
            (candidate) =>
              candidate.id === headId &&
              candidate.facilityId === actor.facilityId &&
              candidate.isActive,
          );
    if (headId != null && !head) return { kind: "invalid_head" as const };

    const existingDepartments = await lockDepartmentNames(tx, actor.facilityId);
    const { names, namesAr } = departmentNameSets(existingDepartments);
    if (hasDepartmentNameConflict(names, namesAr, { name, nameAr })) {
      return { kind: "duplicate" as const };
    }

    const department = (
      await tx
        .insert(departmentsTable)
        .values({ name, nameAr, facilityId: actor.facilityId, headId })
        .returning()
    )[0];
    if (!department) throw new Error("Department insert returned no row");

    await tx
      .insert(auditLogsTable)
      .values(
        departmentAuditValues(
          actor,
          "Created department",
          "إنشاء قسم",
          department,
          req.ip,
        ),
      );
    return { kind: "ok" as const, department };
  });

  if (result.kind === "forbidden") {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (result.kind === "unauthorized") {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  if (result.kind === "invalid_head") {
    res.status(400).json({
      message: "Department head not found in this facility",
    });
    return;
  }
  if (result.kind === "duplicate") {
    res.status(409).json({
      message: "An active department with this name already exists",
      code: "department_name_conflict",
    });
    return;
  }
  res.status(201).json(serializeDepartment(result.department));
});

router.post(
  "/departments/batch",
  requireRole(...ADMIN_ROLES),
  async (req, res) => {
    const parsed = batchCreateDepartmentsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid department batch" });
      return;
    }
    const requestedDepartments = parsed.data.departments.map((department) => ({
      name: department.name.trim(),
      nameAr: department.nameAr.trim(),
    }));
    if (
      requestedDepartments.some(
        (department) => !department.name || !department.nameAr,
      )
    ) {
      res.status(400).json({ message: "name and nameAr are required" });
      return;
    }

    const requestUser = getUser(req);
    const result = await db.transaction(async (tx) => {
      const actor = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, requestUser.id))
          .for("share")
      )[0];
      if (!isFreshActiveSessionActor(actor, requestUser)) {
        return { kind: "unauthorized" as const };
      }
      if (!isCurrentAdmin(actor)) return { kind: "forbidden" as const };

      const existingDepartments = await lockDepartmentNames(
        tx,
        actor.facilityId,
      );
      const { names, namesAr } = departmentNameSets(existingDepartments);
      const created: Department[] = [];
      const skipped: string[] = [];

      for (const requestedDepartment of requestedDepartments) {
        if (hasDepartmentNameConflict(names, namesAr, requestedDepartment)) {
          skipped.push(requestedDepartment.name);
          continue;
        }
        const department = (
          await tx
            .insert(departmentsTable)
            .values({
              ...requestedDepartment,
              facilityId: actor.facilityId,
              headId: null,
            })
            .returning()
        )[0];
        if (!department) throw new Error("Department insert returned no row");
        await tx
          .insert(auditLogsTable)
          .values(
            departmentAuditValues(
              actor,
              "Created department",
              "إنشاء قسم",
              department,
              req.ip,
            ),
          );
        reserveDepartmentName(names, namesAr, requestedDepartment);
        created.push(department);
      }
      return { kind: "ok" as const, created, skipped };
    });

    if (result.kind === "unauthorized") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    res.json({
      created: result.created.map(serializeDepartment),
      skipped: result.skipped,
    });
  },
);

router.get("/departments/:id", async (req, res) => {
  const user = getUser(req);
  const id = Number(req.params.id);
  const rows = await db
    .select()
    .from(departmentsTable)
    .where(
      and(
        eq(departmentsTable.id, id),
        eq(departmentsTable.facilityId, user.facilityId),
        isNull(departmentsTable.deletedAt),
      ),
    );
  const department = rows[0];
  if (!department) {
    res.status(404).json({ message: "Department not found" });
    return;
  }
  res.json(serializeDepartment(department));
});

router.patch(
  "/departments/:id",
  requireRole(...ADMIN_ROLES),
  async (req, res) => {
    const requestUser = getUser(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(404).json({ message: "Department not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const patch: { name?: string; nameAr?: string; headId?: number | null } =
      {};
    if (typeof body.name === "string" && body.name.trim())
      patch.name = body.name.trim();
    if (typeof body.nameAr === "string" && body.nameAr.trim())
      patch.nameAr = body.nameAr.trim();
    if ("headId" in body) {
      const headId = body.headId == null ? null : Number(body.headId);
      if (headId != null && (!Number.isSafeInteger(headId) || headId < 1)) {
        res.status(400).json({
          message: "Department head not found in this facility",
        });
        return;
      }
      patch.headId = headId;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ message: "No valid department fields supplied" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const initialActor = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, requestUser.id))
      )[0];
      if (!isCurrentAdmin(initialActor)) return { kind: "forbidden" as const };

      // Department-referencing mutations lock the department before users. A
      // concurrent employee assignment takes the same order, so deletion cannot
      // miss a newly assigned user or form a department<->user deadlock.
      const department = (
        await tx
          .select()
          .from(departmentsTable)
          .where(
            and(
              eq(departmentsTable.id, id),
              eq(departmentsTable.facilityId, initialActor.facilityId),
              isNull(departmentsTable.deletedAt),
            ),
          )
          .for("update")
      )[0];
      if (!department) return { kind: "not_found" as const };

      const userIds = [
        ...new Set([
          requestUser.id,
          ...(typeof patch.headId === "number" ? [patch.headId] : []),
        ]),
      ];
      const lockedUsers = await tx
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, userIds))
        .orderBy(usersTable.id)
        .for("share");
      const actor = lockedUsers.find(
        (candidate) => candidate.id === requestUser.id,
      );
      if (!isFreshActiveSessionActor(actor, requestUser)) {
        return { kind: "unauthorized" as const };
      }
      if (!isCurrentAdmin(actor)) return { kind: "forbidden" as const };
      if (actor.facilityId !== department.facilityId)
        return { kind: "not_found" as const };

      if (typeof patch.headId === "number") {
        const head = lockedUsers.find(
          (candidate) =>
            candidate.id === patch.headId &&
            candidate.facilityId === department.facilityId &&
            candidate.isActive,
        );
        if (!head) return { kind: "invalid_head" as const };
      }

      if (patch.name != null || patch.nameAr != null) {
        const existingDepartments = await lockDepartmentNames(
          tx,
          department.facilityId,
        );
        const { names, namesAr } = departmentNameSets(
          existingDepartments.filter(
            (candidate) => candidate.id !== department.id,
          ),
        );
        if (
          hasDepartmentNameConflict(names, namesAr, {
            name: patch.name ?? department.name,
            nameAr: patch.nameAr ?? department.nameAr,
          })
        ) {
          return { kind: "duplicate" as const };
        }
      }

      const updated = (
        await tx
          .update(departmentsTable)
          .set(patch)
          .where(
            and(
              eq(departmentsTable.id, department.id),
              eq(departmentsTable.facilityId, department.facilityId),
              isNull(departmentsTable.deletedAt),
            ),
          )
          .returning()
      )[0];
      if (!updated) throw new Error("Department update returned no row");

      await tx
        .insert(auditLogsTable)
        .values(
          departmentAuditValues(
            actor,
            "Updated department",
            "تحديث قسم",
            updated,
            req.ip,
          ),
        );
      return { kind: "ok" as const, department: updated };
    });

    if (result.kind === "forbidden") {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    if (result.kind === "unauthorized") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "not_found") {
      res.status(404).json({ message: "Department not found" });
      return;
    }
    if (result.kind === "invalid_head") {
      res.status(400).json({
        message: "Department head not found in this facility",
      });
      return;
    }
    if (result.kind === "duplicate") {
      res.status(409).json({
        message: "An active department with this name already exists",
        code: "department_name_conflict",
      });
      return;
    }
    res.json(serializeDepartment(result.department));
  },
);

router.delete(
  "/departments/:id",
  requireRole(...ADMIN_ROLES),
  async (req, res) => {
    const requestUser = getUser(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(404).json({ message: "Department not found" });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const initialActor = (
        await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, requestUser.id))
      )[0];
      if (!isCurrentAdmin(initialActor)) return { kind: "forbidden" as const };

      // Lock the department before any user row. Employee assignments use the
      // same order and re-check that this record is still active while locked.
      const department = (
        await tx
          .select()
          .from(departmentsTable)
          .where(
            and(
              eq(departmentsTable.id, id),
              eq(departmentsTable.facilityId, initialActor.facilityId),
              isNull(departmentsTable.deletedAt),
            ),
          )
          .for("update")
      )[0];
      if (!department) return { kind: "not_found" as const };

      const lockedUsers = await tx
        .select()
        .from(usersTable)
        .where(
          or(
            eq(usersTable.id, requestUser.id),
            and(
              eq(usersTable.facilityId, department.facilityId),
              eq(usersTable.departmentId, department.id),
            ),
          ),
        )
        .orderBy(usersTable.id)
        .for("update");
      const actor = lockedUsers.find(
        (candidate) => candidate.id === requestUser.id,
      );
      if (!isFreshActiveSessionActor(actor, requestUser)) {
        return { kind: "unauthorized" as const };
      }
      if (!isCurrentAdmin(actor)) return { kind: "forbidden" as const };
      if (actor.facilityId !== department.facilityId)
        return { kind: "not_found" as const };

      const detachedUsers = await tx
        .update(usersTable)
        .set({
          departmentId: null,
          // Removing a department changes every member's organizational
          // scope; revoke sessions in the same atomic update.
          sessionVersion: sql`${usersTable.sessionVersion} + 1`,
        })
        .where(
          and(
            eq(usersTable.facilityId, department.facilityId),
            eq(usersTable.departmentId, department.id),
          ),
        )
        .returning({ id: usersTable.id });
      const now = new Date();
      const retiredPolicies = await tx
        .update(credentialPoliciesTable)
        .set({ deletedAt: now, deletedBy: actor.id })
        .where(
          and(
            eq(credentialPoliciesTable.facilityId, department.facilityId),
            eq(credentialPoliciesTable.departmentId, department.id),
            isNull(credentialPoliciesTable.deletedAt),
          ),
        )
        .returning({ id: credentialPoliciesTable.id });
      const deleted = (
        await tx
          .update(departmentsTable)
          .set({ deletedAt: now, deletedBy: actor.id })
          .where(
            and(
              eq(departmentsTable.id, department.id),
              eq(departmentsTable.facilityId, department.facilityId),
              isNull(departmentsTable.deletedAt),
            ),
          )
          .returning()
      )[0];
      if (!deleted) throw new Error("Department soft deletion returned no row");

      await tx.insert(auditLogsTable).values(
        departmentAuditValues(
          actor,
          "Deleted department",
          "حذف قسم",
          deleted,
          req.ip,
          JSON.stringify({
            detachedEmployeeCount: detachedUsers.length,
            retiredPolicyCount: retiredPolicies.length,
          }),
        ),
      );
      return { kind: "ok" as const };
    });

    if (result.kind === "forbidden") {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    if (result.kind === "unauthorized") {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    if (result.kind === "not_found") {
      res.status(404).json({ message: "Department not found" });
      return;
    }
    res.status(204).end();
  },
);

export default router;
