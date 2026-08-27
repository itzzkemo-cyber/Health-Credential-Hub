import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getDocumentUploadReadiness } from "../lib/documentUploads";
import { checkObjectStorageReadiness } from "../lib/gcsReadiness";
import { safeErrorLogFields } from "../lib/safeError";
import { getEmailDeliveryReadiness } from "../lib/email/sender";
import { getOcrOperationalReadiness } from "../lib/ocrConfig";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (req, res) => {
  const emailDelivery = getEmailDeliveryReadiness();
  if (emailDelivery === "misconfigured") {
    req.log.error(
      { errorName: "EmailConfigurationError" },
      "Readiness check failed",
    );
    res.status(503).json({ status: "not_ready", emailDelivery });
    return;
  }
  const ocr = getOcrOperationalReadiness();
  if (ocr === "misconfigured") {
    req.log.error(
      { errorName: "OcrConfigurationError" },
      "Readiness check failed",
    );
    res.status(503).json({ status: "not_ready", ocr });
    return;
  }
  try {
    await db.execute(sql`select 1`);
    const objectStorage = await checkObjectStorageReadiness();
    res.json({
      status: "ready",
      database: "ok",
      objectStorage,
      documentUploads: getDocumentUploadReadiness(),
      emailDelivery,
      ocr,
    });
  } catch (error) {
    req.log.error(safeErrorLogFields(error), "Readiness check failed");
    res.status(503).json({ status: "not_ready" });
  }
});

export default router;
