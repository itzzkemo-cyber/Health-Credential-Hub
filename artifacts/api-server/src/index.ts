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

app.listen(port, bindHost, (err) => {
  if (err) {
    logger.error(safeErrorLogFields(err), "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, bindHost }, "Server listening");
  startEmailScheduler();
  startEmployeeInvitationCleanup();
});
