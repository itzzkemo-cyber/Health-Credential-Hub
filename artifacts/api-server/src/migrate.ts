import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "@workspace/db";

const migrationsFolder = path.resolve(
  process.cwd(),
  process.env.MIGRATIONS_DIR ?? "../../lib/db/migrations",
);

try {
  await migrate(db, { migrationsFolder });
  console.log("Database migrations applied successfully.");
} finally {
  await pool.end();
}
