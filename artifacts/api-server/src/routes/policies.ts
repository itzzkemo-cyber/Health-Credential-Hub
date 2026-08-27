import { Router, type IRouter } from "express";
import {
  db,
  auditLogsTable,
  credentialPoliciesTable,
  departmentsTable,
  usersTable,
  CREDENTIAL_TYPES,
  USER_ROLES,
  type CredentialPolicyRow,
  type CredentialType,
  type User,
  type UserRole,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { requireAuth, requireRole, getUser, ADMIN_ROLES } from "../lib/auth";
import { isFreshActiveSessionActor } from "../lib/sessionFreshness";

const router: IRouter = Router();

router.use("/policies", requireAuth);

function serialize(policy: CredentialPolicyRow) {
  return {
    id: policy.id,
    credentialType: policy.credentialType,
    departmentId: policy.departmentId,
    roles: policy.roles ?? [],
    isRequired: policy.isRequired,
    createdAt: policy.createdAt.toISOString(),
  };
}

function isCurrentAdmin(actor: User | undefined): actor is User {
  return Boolean(
    actor?.isActive &&
    ADMIN_ROLES.includes(actor.role as (typeof ADMIN_ROLES)[number]),
  );
}

function policyAuditValues(
  actor: User,
  action: string,
  actionAr: string,
  policy: CredentialPolicyRow,
  ipAddress: string | undefined,
) {
  return {
    userId: actor.id,
    facilityId: policy.facilityId,
    userName: actor.name,
    userNameAr: actor.nameAr,
    action,
    actionAr,
    target: `Requirement: ${policy.credentialType}`,
    targetAr: `اشتراط: ${policy.credentialType}`,
    details: null,
    ipAddress: ipAddress ?? null,
  };
}

router.get("/policies", async (req, res) => {
  const user = getUser(req);
  const rows = await db
    .select()
    .from(credentialPoliciesTable)
    .where(
      and(
        eq(credentialPoliciesTable.facilityId, user.facilityId),
        isNull(credentialPoliciesTable.deletedAt),
      ),
    );
  res.json(rows.map(serialize));
});

router.post("/policies", requireRole(...ADMIN_ROLES), async (req, res) => {
  const requestUser = getUser(req);
  const { credentialType, departmentId, roles, isRequired } = req.body as {
    credentialType?: string;
    departmentId?: number | null;
    roles?: string[];
    isRequired?: boolean;
  };
  if (
    !credentialType ||
    !CREDENTIAL_TYPES.includes(credentialType as CredentialType)
  ) {
    res.status(400).json({ message: "Invalid credentialType" });
    return;
  }
  if (isRequired !== undefined && typeof isRequired !== "boolean") {
    res.status(400).json({ message: "isRequired must be a boolean" });
    return;
  }
  const normalizedDepartmentId =
    departmentId == null ? null : Number(departmentId);
  if (
    normalizedDepartmentId != null &&
    (!Number.isSafeInteger(normalizedDepartmentId) ||
      normalizedDepartmentId < 1)
  ) {
    res.status(400).json({ message: "Invalid departmentId" });
    return;
  }
  const normalizedRoles = Array.isArray(roles) ? [...new Set(roles)] : [];
  if (
    !normalizedRoles.every(
      (role): role is UserRole =>
        typeof role === "string" && USER_ROLES.includes(role as UserRole),
    )
  ) {
    res.status(400).json({ message: "Invalid policy role" });
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

    let departmentFacilityId: number | null = null;
    if (normalizedDepartmentId != null) {
      const department = (
        await tx
          .select({ id: departmentsTable.id })
          .from(departmentsTable)
          .where(
            and(
              eq(departmentsTable.id, normalizedDepartmentId),
              eq(departmentsTable.facilityId, initialActor.facilityId),
              isNull(departmentsTable.deletedAt),
            ),
          )
          .for("share")
      )[0];
      if (!department) return { kind: "invalid_department" as const };
      departmentFacilityId = initialActor.facilityId;
    }

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
    if (
      departmentFacilityId != null &&
      actor.facilityId !== departmentFacilityId
    )
      return { kind: "invalid_department" as const };

    const policy = (
      await tx
        .insert(credentialPoliciesTable)
        .values({
          facilityId: actor.facilityId,
          credentialType,
          departmentId: normalizedDepartmentId,
          roles: normalizedRoles,
          isRequired: isRequired ?? true,
        })
        .returning()
    )[0];
    if (!policy) throw new Error("Policy insert returned no row");

    await tx
      .insert(auditLogsTable)
      .values(
        policyAuditValues(
          actor,
          "Created policy",
          "إنشاء سياسة",
          policy,
          req.ip,
        ),
      );
    return { kind: "ok" as const, policy };
  });

  if (result.kind === "forbidden") {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (result.kind === "unauthorized") {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  if (result.kind === "invalid_department") {
    res.status(400).json({ message: "Department not found in this facility" });
    return;
  }
  res.status(201).json(serialize(result.policy));
});

router.delete(
  "/policies/:id",
  requireRole(...ADMIN_ROLES),
  async (req, res) => {
    const requestUser = getUser(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(404).json({ message: "Policy not found" });
      return;
    }

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

      const policy = (
        await tx
          .select()
          .from(credentialPoliciesTable)
          .where(
            and(
              eq(credentialPoliciesTable.id, id),
              eq(credentialPoliciesTable.facilityId, actor.facilityId),
              isNull(credentialPoliciesTable.deletedAt),
            ),
          )
          .for("update")
      )[0];
      if (!policy) return { kind: "not_found" as const };

      const deleted = (
        await tx
          .update(credentialPoliciesTable)
          .set({ deletedAt: new Date(), deletedBy: actor.id })
          .where(
            and(
              eq(credentialPoliciesTable.id, policy.id),
              eq(credentialPoliciesTable.facilityId, policy.facilityId),
              isNull(credentialPoliciesTable.deletedAt),
            ),
          )
          .returning()
      )[0];
      if (!deleted) throw new Error("Policy soft deletion returned no row");

      await tx
        .insert(auditLogsTable)
        .values(
          policyAuditValues(
            actor,
            "Deleted policy",
            "حذف سياسة",
            deleted,
            req.ip,
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
      res.status(404).json({ message: "Policy not found" });
      return;
    }
    res.status(204).end();
  },
);

export default router;
