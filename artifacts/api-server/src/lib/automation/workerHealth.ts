import { createServer, type Server, type ServerResponse } from "node:http";

import { safeErrorLogFields, type SafeErrorLogFields } from "../safeError";

export type AutomationWorkerHealthState =
  "starting" | "ready" | "stopping" | "failed";

interface AutomationWorkerHealthLogger {
  error(fields: SafeErrorLogFields, message: string): void;
}

interface CreateAutomationWorkerHealthServerOptions {
  getState(): AutomationWorkerHealthState;
  probeDatabase(): Promise<void>;
  log: AutomationWorkerHealthLogger;
  releaseSha?: string;
}

const RELEASE_SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const READINESS_PROBE_CACHE_MS = 2_000;

function releaseMetadata(releaseSha: string | undefined): {
  releaseSha?: string;
} {
  const normalized = releaseSha?.trim();
  return normalized && RELEASE_SHA_PATTERN.test(normalized)
    ? { releaseSha: normalized }
    : {};
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
  headOnly = false,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(headOnly ? undefined : body);
}

/**
 * Expose only fixed liveness/readiness responses for the dedicated worker.
 * No outbox contents, provider URLs, database errors, or secrets are returned.
 */
export function createAutomationWorkerHealthServer(
  options: CreateAutomationWorkerHealthServerOptions,
): Server {
  const metadata = releaseMetadata(options.releaseSha);
  let probeInFlight: Promise<boolean> | undefined;
  let cachedProbe: { ok: boolean; validUntilMs: number } | undefined;
  const databaseReady = async (): Promise<boolean> => {
    const now = Date.now();
    if (cachedProbe && now < cachedProbe.validUntilMs) {
      return cachedProbe.ok;
    }
    if (probeInFlight) return probeInFlight;
    probeInFlight = options
      .probeDatabase()
      .then(() => true)
      .catch((error: unknown) => {
        options.log.error(
          safeErrorLogFields(error),
          "Automation worker readiness check failed",
        );
        return false;
      })
      .then((ok) => {
        cachedProbe = {
          ok,
          validUntilMs: Date.now() + READINESS_PROBE_CACHE_MS,
        };
        return ok;
      })
      .finally(() => {
        probeInFlight = undefined;
      });
    return probeInFlight;
  };

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const headOnly = method === "HEAD";
    if (method !== "GET" && !headOnly) {
      response.setHeader("Allow", "GET, HEAD");
      writeJson(response, 405, { status: "method_not_allowed" });
      return;
    }

    const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
    const state = options.getState();
    if (path === "/healthz") {
      const live = state !== "failed" && state !== "stopping";
      writeJson(
        response,
        live ? 200 : 503,
        { status: live ? "ok" : "not_ready", ...metadata },
        headOnly,
      );
      return;
    }

    if (path === "/readyz") {
      if (state !== "ready") {
        writeJson(
          response,
          503,
          { status: "not_ready", ...metadata },
          headOnly,
        );
        return;
      }
      if (await databaseReady()) {
        writeJson(
          response,
          200,
          {
            status: "ready",
            database: "ok",
            worker: "running",
            ...metadata,
          },
          headOnly,
        );
      } else {
        writeJson(
          response,
          503,
          { status: "not_ready", ...metadata },
          headOnly,
        );
      }
      return;
    }

    writeJson(response, 404, { status: "not_found" }, headOnly);
  });

  // The public listener exists only for bounded health checks.
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  return server;
}

export async function listenForAutomationWorkerHealth(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function closeAutomationWorkerHealthServer(
  server: Server,
): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}
