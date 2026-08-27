import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "@workspace/db";
import {
  readDatabaseRoleBoundaryConfig,
  runMigrationWithRoleBoundary,
} from "./lib/databaseRoleBoundary";

const migrationsFolder = path.resolve(
  process.cwd(),
  process.env.MIGRATIONS_DIR ?? "../../lib/db/migrations",
);

try {
  const roleBoundary = readDatabaseRoleBoundaryConfig();
  const runMigration = () => migrate(db, { migrationsFolder });
  if (roleBoundary) {
    await runMigrationWithRoleBoundary(pool, roleBoundary, runMigration);
  } else {
    await runMigration();
  }
  console.log("Database migrations applied successfully.");
} finally {
  await pool.end();
}
