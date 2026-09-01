import { Router, type IRouter } from "express";
import {
  HealthCheckResponse,
  ReadinessCheckResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getDocumentUploadReadiness } from "../lib/documentUploads";
import { checkObjectStorageReadiness } from "../lib/gcsReadiness";
import { safeErrorLogFields } from "../lib/safeError";
import { getEmailDeliveryReadiness } from "../lib/email/sender";
import { getOcrOperationalReadiness } from "../lib/ocrConfig";
import { getSmsOtpReadiness } from "../lib/sms/provider";

const router: IRouter = Router();

const RELEASE_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

function getReleaseMetadata(): { releaseSha?: string } {
  for (const candidate of [
    process.env.RENDER_GIT_COMMIT,
    process.env.RELEASE_SHA,
  ]) {
    const releaseSha = candidate?.trim();
    if (releaseSha && RELEASE_SHA_PATTERN.test(releaseSha)) {
      return { releaseSha };
    }
  }
  return {};
}

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({
    status: "ok",
    ...getReleaseMetadata(),
  });
  res.json(data);
});

router.get("/readyz", async (req, res) => {
  const releaseMetadata = getReleaseMetadata();
  const smsOtp = getSmsOtpReadiness();
  if (smsOtp === "misconfigured") {
    req.log.error(
      { errorName: "SmsOtpConfigurationError" },
      "Readiness check failed",
    );
    res.status(503).json(
      HealthCheckResponse.parse({
        status: "not_ready",
        ...releaseMetadata,
        smsOtp,
      }),
    );
    return;
  }
  const emailDelivery = getEmailDeliveryReadiness();
  if (emailDelivery === "misconfigured") {
    req.log.error(
      { errorName: "EmailConfigurationError" },
      "Readiness check failed",
    );
    res.status(503).json(
      HealthCheckResponse.parse({
        status: "not_ready",
        ...releaseMetadata,
        emailDelivery,
      }),
    );
    return;
  }
  const ocr = getOcrOperationalReadiness();
  if (ocr === "misconfigured") {
    req.log.error(
      { errorName: "OcrConfigurationError" },
      "Readiness check failed",
    );
    res.status(503).json(
      HealthCheckResponse.parse({
        status: "not_ready",
        ...releaseMetadata,
        ocr,
      }),
    );
    return;
  }
  try {
    await db.execute(sql`select 1`);
    const objectStorage = await checkObjectStorageReadiness();
    res.json(
      ReadinessCheckResponse.parse({
        status: "ready",
        ...releaseMetadata,
        database: "ok",
        objectStorage,
        documentUploads: getDocumentUploadReadiness(),
        smsOtp,
        emailDelivery,
        ocr,
      }),
    );
  } catch (error) {
    req.log.error(safeErrorLogFields(error), "Readiness check failed");
    res.status(503).json(
      HealthCheckResponse.parse({
        status: "not_ready",
        ...releaseMetadata,
      }),
    );
  }
});

export default router;
