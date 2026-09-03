import { fileURLToPath } from "node:url";
import path from "node:path";

import { logger } from "./lib/logger";
import { safeErrorLogFields } from "./lib/safeError";
import { readAutomationConfig } from "./lib/automation/config";
import { resolveBindHost } from "./lib/bindHost";
import {
  readDatabaseRoleBoundaryConfig,
  verifyApplicationDatabaseRoleBoundary,
} from "./lib/databaseRoleBoundary";
import {
  closeAutomationWorkerHealthServer,
  createAutomationWorkerHealthServer,
  listenForAutomationWorkerHealth,
  type AutomationWorkerHealthState,
} from "./lib/automation/workerHealth";

type AutomationWorkerMode = "once" | "continuous";

export function readAutomationWorkerMode(
  env: NodeJS.ProcessEnv = process.env,
): AutomationWorkerMode {
  const mode = env.AUTOMATION_WORKER_MODE?.trim() || "once";
  if (mode === "once" || mode === "continuous") return mode;
  throw new Error("AUTOMATION_WORKER_MODE must be once or continuous");
}

function readRequiredPort(env: NodeJS.ProcessEnv): number {
  const rawPort = env.PORT;
  if (!rawPort) {
    throw new Error(
      "PORT is required for a continuous automation worker health listener",
    );
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

async function runAutomationWorker(): Promise<void> {
  const mode = readAutomationWorkerMode();
  const config = readAutomationConfig();
  if (!config.enabled) {
    if (mode === "continuous") {
      throw new Error(
        "A continuous automation worker requires an enabled webhook configuration",
      );
    }
    logger.warn(
      "Automation webhook is disabled; no outbox events were scanned or delivered",
    );
    return;
  }

  const { pool } = await import("@workspace/db");
  const { runAutomationWorkerContinuously, runAutomationWorkerCycle } =
    await import("./lib/automation/worker");
  try {
    const databaseRoleBoundary = readDatabaseRoleBoundaryConfig();
    if (databaseRoleBoundary) {
      await verifyApplicationDatabaseRoleBoundary(pool, databaseRoleBoundary);
    }

    if (mode === "once") {
      const count = await runAutomationWorkerCycle(config);
      logger.info({ count }, "Automation worker one-shot cycle completed");
      return;
    }

    const port = readRequiredPort(process.env);
    const bindHost = resolveBindHost();
    const state: { current: AutomationWorkerHealthState } = {
      current: "starting",
    };
    const probeDatabase = async () => {
      await pool.query("select 1");
    };
    // Fail the deploy before advertising readiness if the worker cannot reach
    // its durable outbox with the reviewed least-privilege login.
    await probeDatabase();
    const healthServer = createAutomationWorkerHealthServer({
      getState: () => state.current,
      probeDatabase,
      log: logger,
      releaseSha: process.env.RENDER_GIT_COMMIT ?? process.env.RELEASE_SHA,
    });
    await listenForAutomationWorkerHealth(healthServer, port, bindHost);

    const controller = new AbortController();
    const onSignal = () => {
      state.current = "stopping";
      controller.abort();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, onSignal);
    }
    state.current = "ready";
    logger.info(
      { port, bindHost },
      "Dedicated automation worker started in continuous mode",
    );

    try {
      await runAutomationWorkerContinuously(config, controller.signal);
      if (!controller.signal.aborted) {
        throw new Error("Automation worker stopped unexpectedly");
      }
    } catch (error) {
      state.current = "failed";
      logger.error(
        safeErrorLogFields(error),
        "Dedicated automation worker became unavailable",
      );
      throw new Error("Dedicated automation worker became unavailable");
    } finally {
      if (state.current !== "failed") state.current = "stopping";
      controller.abort();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.removeListener(signal, onSignal);
      }
      await closeAutomationWorkerHealthServer(healthServer);
    }
  } finally {
    await pool.end();
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint &&
    path.resolve(entrypoint) === path.resolve(fileURLToPath(import.meta.url)),
  );
}

if (isMainModule()) {
  runAutomationWorker().catch((error: unknown) => {
    logger.error(
      safeErrorLogFields(error),
      "Automation worker process failed to start or remain available",
    );
    process.exitCode = 1;
  });
}
