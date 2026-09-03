import app from "./app";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { safeErrorLogFields } from "./lib/safeError";
import { startEmailScheduler } from "./lib/email/scheduler";
import { startEmployeeInvitationCleanup } from "./lib/employeeInvitationCleanup";
import { resolveBindHost } from "./lib/bindHost";
import {
  readDatabaseRoleBoundaryConfig,
  verifyApplicationDatabaseRoleBoundary,
} from "./lib/databaseRoleBoundary";
import {
  startEmbeddedAutomationWorker,
  type EmbeddedAutomationWorkerHandle,
} from "./lib/automation/embeddedWorker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const bindHost = resolveBindHost();
const databaseRoleBoundary = readDatabaseRoleBoundaryConfig();
if (databaseRoleBoundary) {
  await verifyApplicationDatabaseRoleBoundary(pool, databaseRoleBoundary);
}

const shutdownController = new AbortController();
let stopInvitationCleanup: (() => void) | undefined;
let embeddedWorker: EmbeddedAutomationWorkerHandle | null;
try {
  // Validate the explicit pilot opt-in before opening the HTTP listener. A
  // malformed enabled configuration must not leave an apparently healthy API
  // process whose automation worker never started.
  embeddedWorker = await startEmbeddedAutomationWorker({
    signal: shutdownController.signal,
  });
} catch (error) {
  logger.error(
    safeErrorLogFields(error),
    "Embedded automation worker configuration prevented API startup",
  );
  throw new Error("Embedded automation worker configuration is invalid");
}
let shutdownPromise: Promise<void> | undefined;

const server = app.listen(port, bindHost, (err) => {
  if (err) {
    logger.error(safeErrorLogFields(err), "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, bindHost }, "Server listening");
  startEmailScheduler();
  stopInvitationCleanup = startEmployeeInvitationCleanup();
});

async function closeHttpServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

type ShutdownReason = "SIGINT" | "SIGTERM" | "embedded_worker_failure";

async function shutdown(reason: ShutdownReason): Promise<void> {
  logger.info({ reason }, "Graceful shutdown started");
  shutdownController.abort();
  stopInvitationCleanup?.();

  const results = await Promise.allSettled([
    closeHttpServer(),
    embeddedWorker?.stop() ?? Promise.resolve(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error(
        safeErrorLogFields(result.reason),
        "A component failed during graceful shutdown",
      );
      process.exitCode = 1;
    }
  }

  try {
    await pool.end();
  } catch (error) {
    logger.error(
      safeErrorLogFields(error),
      "Database pool failed to close during graceful shutdown",
    );
    process.exitCode = 1;
  }
}

if (embeddedWorker) {
  void embeddedWorker.completion.catch((error: unknown) => {
    logger.error(
      safeErrorLogFields(error),
      "Embedded automation worker exhausted retries; shutting down API",
    );
    process.exitCode = 1;
    shutdownPromise ??= shutdown("embedded_worker_failure").catch(
      (shutdownError: unknown) => {
        logger.error(
          safeErrorLogFields(shutdownError),
          "Unexpected graceful shutdown failure",
        );
        process.exitCode = 1;
      },
    );
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdownPromise ??= shutdown(signal).catch((error: unknown) => {
      logger.error(
        safeErrorLogFields(error),
        "Unexpected graceful shutdown failure",
      );
      process.exitCode = 1;
    });
    void shutdownPromise;
  });
}
