import { logger } from "./lib/logger";
import { readAutomationConfig } from "./lib/automation/config";

const config = readAutomationConfig();
if (!config.enabled) {
  logger.warn(
    "Automation webhook is disabled; no outbox events were scanned or delivered",
  );
} else {
  const { pool } = await import("@workspace/db");
  const { runAutomationWorkerContinuously, runAutomationWorkerCycle } =
    await import("./lib/automation/worker");
  const mode = process.env.AUTOMATION_WORKER_MODE ?? "once";
  try {
    if (mode === "once") {
      const count = await runAutomationWorkerCycle(config);
      logger.info({ count }, "Automation worker one-shot cycle completed");
    } else if (mode === "continuous") {
      const controller = new AbortController();
      for (const event of ["SIGINT", "SIGTERM"] as const) {
        process.once(event, () => controller.abort());
      }
      logger.info("Automation worker started in continuous mode");
      await runAutomationWorkerContinuously(config, controller.signal);
    } else {
      throw new Error("AUTOMATION_WORKER_MODE must be once or continuous");
    }
  } finally {
    await pool.end();
  }
}
