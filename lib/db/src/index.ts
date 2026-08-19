import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const configuredPoolMax = Number(process.env.DB_POOL_MAX ?? 10);
if (!Number.isSafeInteger(configuredPoolMax) || configuredPoolMax < 1 || configuredPoolMax > 50) {
  throw new Error("DB_POOL_MAX must be an integer between 1 and 50");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: configuredPoolMax,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
