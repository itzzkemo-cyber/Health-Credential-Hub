import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/index";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

try {
  await migrate(db, { migrationsFolder });
  console.log("Database migrations applied successfully.");
} finally {
  await pool.end();
}
