import { logger } from "../logger";
import { safeErrorLogFields, type SafeErrorLogFields } from "../safeError";
import { readAutomationConfig, type AutomationConfig } from "./config";

export interface EmbeddedAutomationWorkerHandle {
  readonly completion: Promise<void>;
  getState(): EmbeddedAutomationWorkerState;
  stop(): Promise<void>;
}

export type EmbeddedAutomationWorkerState =
  | { status: "starting"; consecutiveFailures: number }
  | { status: "running"; consecutiveFailures: number }
  | {
      status: "backing_off";
      consecutiveFailures: number;
      retryDelayMs: number;
    }
  | { status: "failed"; consecutiveFailures: number }
  | { status: "stopped"; consecutiveFailures: number };

interface EmbeddedAutomationWorkerLogger {
  warn(message: string): void;
  error(fields: SafeErrorLogFields, message: string): void;
}

interface AutomationWorkerModule {
  runAutomationWorkerContinuously(
    config: AutomationConfig,
    signal: AbortSignal,
  ): Promise<void>;
}

interface StartEmbeddedAutomationWorkerOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  readConfig?: (env: NodeJS.ProcessEnv) => AutomationConfig;
  loadWorker?: () => Promise<AutomationWorkerModule>;
  log?: EmbeddedAutomationWorkerLogger;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxConsecutiveFailures?: number;
  stableRunMs?: number;
  now?: () => number;
}

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 8;
const STABLE_RUN_MS = 60_000;

class EmbeddedAutomationWorkerExitedError extends Error {
  override readonly name = "EmbeddedAutomationWorkerExitedError";
}

class EmbeddedAutomationWorkerUnavailableError extends Error {
  override readonly name = "EmbeddedAutomationWorkerUnavailableError";
}

const defaultLog: EmbeddedAutomationWorkerLogger = {
  warn: (message) => logger.warn(message),
  error: (fields, message) => logger.error(fields, message),
};

function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Pilot-only switch for colocating delivery with the public API process.
 *
 * This is deliberately independent from the outbox/webhook switches: an
 * operator must opt in to all three boundaries, and a dedicated worker remains
 * the production deployment model.
 */
export function isEmbeddedAutomationWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env.AUTOMATION_EMBEDDED_WORKER_ENABLED?.trim().toLowerCase();
  if (flag == null || flag === "" || flag === "false" || flag === "0") {
    return false;
  }
  if (flag === "true" || flag === "1") return true;
  throw new Error("AUTOMATION_EMBEDDED_WORKER_ENABLED must be true or false");
}

/**
 * Start the continuous outbox worker without blocking API startup.
 *
 * Module-load and unexpected runtime failures are supervised with bounded
 * exponential backoff. Repeated failures reject `completion` with a generic
 * error so the API entrypoint can fail readiness by terminating the process
 * instead of remaining healthy with permanently dead automation. `stop` is
 * idempotent, and provider error messages/stacks are never logged or rethrown.
 */
export async function startEmbeddedAutomationWorker(
  options: StartEmbeddedAutomationWorkerOptions = {},
): Promise<EmbeddedAutomationWorkerHandle | null> {
  const env = options.env ?? process.env;
  if (!isEmbeddedAutomationWorkerEnabled(env)) return null;

  const config = (options.readConfig ?? readAutomationConfig)(env);
  if (!config.enabled) {
    throw new Error(
      "AUTOMATION_EMBEDDED_WORKER_ENABLED requires a fully enabled automation webhook configuration",
    );
  }

  const controller = new AbortController();
  const externalSignal = options.signal;
  const forwardAbort = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  }

  const detachExternalSignal = () =>
    externalSignal?.removeEventListener("abort", forwardAbort);

  if (controller.signal.aborted) {
    detachExternalSignal();
    return null;
  }

  const log = options.log ?? defaultLog;
  const retryBaseDelay = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  const retryMaxDelay = options.retryMaxDelayMs ?? RETRY_MAX_DELAY_MS;
  const maxConsecutiveFailures =
    options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
  const stableRunMs = options.stableRunMs ?? STABLE_RUN_MS;
  const now = options.now ?? Date.now;
  if (
    !Number.isSafeInteger(retryBaseDelay) ||
    retryBaseDelay < 1 ||
    !Number.isSafeInteger(retryMaxDelay) ||
    retryMaxDelay < retryBaseDelay ||
    !Number.isSafeInteger(maxConsecutiveFailures) ||
    maxConsecutiveFailures < 1 ||
    !Number.isSafeInteger(stableRunMs) ||
    stableRunMs < 1
  ) {
    detachExternalSignal();
    throw new Error("Invalid embedded automation worker supervision settings");
  }

  log.warn(
    "Embedded automation worker started in pilot mode; use a dedicated worker for production",
  );

  let state: EmbeddedAutomationWorkerState = {
    status: "starting",
    consecutiveFailures: 0,
  };
  const completion = (async () => {
    let consecutiveFailures = 0;
    while (!controller.signal.aborted) {
      let runStartedAt: number | undefined;
      try {
        state = { status: "starting", consecutiveFailures };
        const workerModule = await (
          options.loadWorker ?? (() => import("./worker"))
        )();
        if (controller.signal.aborted) break;

        runStartedAt = now();
        state = { status: "running", consecutiveFailures };
        await workerModule.runAutomationWorkerContinuously(
          config,
          controller.signal,
        );
        if (controller.signal.aborted) break;
        throw new EmbeddedAutomationWorkerExitedError();
      } catch (error) {
        if (controller.signal.aborted) break;
        if (
          runStartedAt != null &&
          Math.max(0, now() - runStartedAt) >= stableRunMs
        ) {
          consecutiveFailures = 0;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          state = { status: "failed", consecutiveFailures };
          log.error(
            safeErrorLogFields(error),
            "Embedded automation worker unavailable after bounded retries",
          );
          throw new EmbeddedAutomationWorkerUnavailableError();
        }

        const delayMs = retryDelayMs(
          consecutiveFailures,
          retryBaseDelay,
          retryMaxDelay,
        );
        state = {
          status: "backing_off",
          consecutiveFailures,
          retryDelayMs: delayMs,
        };
        log.error(
          safeErrorLogFields(error),
          "Embedded automation worker attempt failed; retry scheduled",
        );
        await waitForRetry(delayMs, controller.signal);
      }
    }
  })().finally(() => {
    detachExternalSignal();
    if (state.status !== "failed") {
      state = {
        status: "stopped",
        consecutiveFailures: state.consecutiveFailures,
      };
    }
  });

  // Attach an internal observer immediately so a fast terminal failure can
  // never become an unhandled rejection before the API entrypoint subscribes.
  void completion.catch(() => undefined);

  return {
    completion,
    getState() {
      return { ...state };
    },
    async stop() {
      controller.abort();
      try {
        await completion;
      } catch (error) {
        if (state.status !== "failed") throw error;
      }
    },
  };
}
