import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { safeErrorLogFields } from "../lib/safeError";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (req, res) => {
  try {
    await db.execute(sql`select 1`);
    if (!process.env.PRIVATE_OBJECT_DIR) {
      throw new Error("Private object storage is not configured");
    }
    res.json({ status: "ready", database: "ok", objectStorage: "configured" });
  } catch (error) {
    req.log.error(safeErrorLogFields(error), "Readiness check failed");
    res.status(503).json({ status: "not_ready" });
  }
});

export default router;
