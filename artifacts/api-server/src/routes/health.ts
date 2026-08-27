import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getDocumentUploadReadiness } from "../lib/documentUploads";
import { checkObjectStorageReadiness } from "../lib/gcsReadiness";
import { safeErrorLogFields } from "../lib/safeError";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (req, res) => {
  try {
    await db.execute(sql`select 1`);
    const objectStorage = await checkObjectStorageReadiness();
    res.json({
      status: "ready",
      database: "ok",
      objectStorage,
      documentUploads: getDocumentUploadReadiness(),
    });
  } catch (error) {
    req.log.error(safeErrorLogFields(error), "Readiness check failed");
    res.status(503).json({ status: "not_ready" });
  }
});

export default router;
