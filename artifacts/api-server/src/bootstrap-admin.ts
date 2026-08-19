import bcrypt from "bcryptjs";
import {
  auditLogsTable,
  db,
  facilitiesTable,
  pool,
  usersTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import {
  BootstrapAdminConfigError,
  readBootstrapAdminConfig,
} from "./lib/bootstrapAdminConfig";

class BootstrapRefusedError extends Error {}

async function bootstrap(): Promise<number> {
  const config = readBootstrapAdminConfig();
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const passwordHash = await bcrypt.hash(config.password, 12);
  config.password = "";

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('health-credential-bootstrap-first-admin'))`,
    );
    const existingAdmins = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(inArray(usersTable.role, ["hospital_admin", "system_admin"]))
      .limit(1);
    if (existingAdmins.length > 0) {
      throw new BootstrapRefusedError(
        "An administrator already exists; this first-admin command never updates or resets existing accounts",
      );
    }

    let facilityId: number;
    if (config.facility.mode === "existing") {
      const facility = (
        await tx
          .select({ id: facilitiesTable.id })
          .from(facilitiesTable)
          .where(eq(facilitiesTable.id, config.facility.id))
          .for("update")
      )[0];
      if (!facility) {
        throw new BootstrapRefusedError(
          "Target facility does not exist; no account was changed",
        );
      }
      facilityId = facility.id;
    } else {
      const facility = (
        await tx
          .insert(facilitiesTable)
          .values({
            name: config.facility.name,
            nameAr: config.facility.nameAr,
          })
          .returning({ id: facilitiesTable.id })
      )[0];
      if (!facility) throw new Error("Facility insert returned no row");
      facilityId = facility.id;
    }
    const existingEmail = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, config.email))
      .limit(1);
    if (existingEmail.length > 0) {
      throw new BootstrapRefusedError(
        "The requested email already exists; no account was changed",
      );
    }

    const admin = (
      await tx
        .insert(usersTable)
        .values({
          email: config.email,
          passwordHash,
          name: config.name,
          nameAr: config.nameAr,
          role: config.role,
          facilityId,
          employeeNumber: config.employeeNumber,
          jobTitle: "Credential administrator",
          jobTitleAr: "مسؤول الاعتمادات",
          isActive: true,
        })
        .returning()
    )[0];
    if (!admin) throw new Error("Administrator insert returned no row");
    await tx.insert(auditLogsTable).values({
      userId: admin.id,
      facilityId: admin.facilityId,
      userName: admin.name,
      userNameAr: admin.nameAr,
      action: "Bootstrapped first administrator",
      actionAr: "إنشاء أول مسؤول للنظام",
      target: "Administrator account",
      targetAr: "حساب المسؤول",
      details: "Created by the guarded production bootstrap command",
      ipAddress: null,
    });
    return admin.id;
  });
}

try {
  const adminId = await bootstrap();
  console.log(`First administrator created successfully (user id ${adminId}).`);
} catch (error) {
  if (
    error instanceof BootstrapRefusedError ||
    error instanceof BootstrapAdminConfigError
  ) {
    console.error(error.message);
  } else {
    console.error(
      "Administrator bootstrap failed without changing an account; inspect restricted service logs for the database error.",
    );
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
