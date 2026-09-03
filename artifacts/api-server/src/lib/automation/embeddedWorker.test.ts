import { describe, expect, it, vi } from "vitest";
import type { AutomationConfig } from "./config";
import {
  isEmbeddedAutomationWorkerEnabled,
  startEmbeddedAutomationWorker,
} from "./embeddedWorker";

const enabledConfig: AutomationConfig = {
  enabled: true,
  facilityAllowlist: [17],
  requirePublicAddress: true,
  webhookUrl: new URL("https://n8n.example.sa/webhook/healthdocs"),
  secret: Buffer.alloc(32, 7),
  headerAuthSecret: Buffer.alloc(32, 8).toString("base64"),
  timeoutMs: 5_000,
  maxAttempts: 8,
  batchSize: 25,
  pollIntervalMs: 30_000,
  lockTimeoutMs: 300_000,
  retentionDays: 30,
  pendingMaxAgeDays: 7,
};

describe("embedded automation worker", () => {
  it("is disabled by default and validates an explicit flag", () => {
    expect(isEmbeddedAutomationWorkerEnabled({})).toBe(false);
    expect(
      isEmbeddedAutomationWorkerEnabled({
        AUTOMATION_EMBEDDED_WORKER_ENABLED: "true",
      }),
    ).toBe(true);
    expect(() =>
      isEmbeddedAutomationWorkerEnabled({
        AUTOMATION_EMBEDDED_WORKER_ENABLED: "sometimes",
      }),
    ).toThrow(/must be true or false/);
  });

  it("does not read provider configuration or load worker code while disabled", async () => {
    const readConfig = vi.fn(() => enabledConfig);
    const loadWorker = vi.fn();

    await expect(
      startEmbeddedAutomationWorker({ env: {}, readConfig, loadWorker }),
    ).resolves.toBeNull();
    expect(readConfig).not.toHaveBeenCalled();
    expect(loadWorker).not.toHaveBeenCalled();
  });

  it("fails closed when the webhook worker configuration is disabled", async () => {
    const loadWorker = vi.fn();

    await expect(
      startEmbeddedAutomationWorker({
        env: { AUTOMATION_EMBEDDED_WORKER_ENABLED: "true" },
        readConfig: () => ({ ...enabledConfig, enabled: false }),
        loadWorker,
      }),
    ).rejects.toThrow(/fully enabled automation webhook configuration/);
    expect(loadWorker).not.toHaveBeenCalled();
  });

  it("runs asynchronously and stops through an AbortController", async () => {
    let workerSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const run = vi.fn(
      async (_config: AutomationConfig, signal: AbortSignal) => {
        workerSignal = signal;
        markStarted?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const log = { warn: vi.fn(), error: vi.fn() };

    const handle = await startEmbeddedAutomationWorker({
      env: { AUTOMATION_EMBEDDED_WORKER_ENABLED: "true" },
      readConfig: () => enabledConfig,
      loadWorker: async () => ({ runAutomationWorkerContinuously: run }),
      log,
    });

    expect(handle).not.toBeNull();
    await started;
    expect(run).toHaveBeenCalledOnce();
    expect(workerSignal?.aborted).toBe(false);
    await handle?.stop();
    expect(workerSignal?.aborted).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/pilot mode/));
    expect(log.error).not.toHaveBeenCalled();
  });

  it("retries a runtime failure and logs no error message or stack", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const providerError = Object.assign(
      new Error("secret-bearing provider response"),
      { code: "ECONNRESET" },
    );
    let runCount = 0;

    const handle = await startEmbeddedAutomationWorker({
      env: { AUTOMATION_EMBEDDED_WORKER_ENABLED: "true" },
      readConfig: () => enabledConfig,
      loadWorker: async () => ({
        runAutomationWorkerContinuously: async (_config, signal) => {
          runCount += 1;
          if (runCount === 1) throw providerError;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      }),
      log,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    await vi.waitFor(() => expect(runCount).toBe(2));

    expect(log.error).toHaveBeenCalledWith(
      { errorName: "Error", errorCode: "ECONNRESET" },
      "Embedded automation worker attempt failed; retry scheduled",
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(
      "secret-bearing provider response",
    );
    expect(handle?.getState()).toEqual({
      status: "running",
      consecutiveFailures: 1,
    });
    await handle?.stop();
  });

  it("treats an unexpected normal worker return as retryable", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(async () => undefined);
    const handle = await startEmbeddedAutomationWorker({
      env: { AUTOMATION_EMBEDDED_WORKER_ENABLED: "true" },
      readConfig: () => enabledConfig,
      loadWorker: async () => ({ runAutomationWorkerContinuously: run }),
      log,
      // Keep the retry window open until the assertion observes it. This
      // avoids coupling the test to scheduler timing while still proving that
      // shutdown cancels the pending retry.
      retryBaseDelayMs: 60_000,
      retryMaxDelayMs: 60_000,
    });

    await vi.waitFor(() =>
      expect(handle?.getState()).toEqual({
        status: "backing_off",
        consecutiveFailures: 1,
        retryDelayMs: 60_000,
      }),
    );
    expect(run).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      { errorName: "EmbeddedAutomationWorkerExitedError" },
      "Embedded automation worker attempt failed; retry scheduled",
    );
    await handle?.stop();
    expect(run).toHaveBeenCalledOnce();
  });

  it("retries a transient worker-module load failure", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const providerError = Object.assign(new Error("private module path"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    let loadCount = 0;
    let receivedSignal: AbortSignal | undefined;
    const handle = await startEmbeddedAutomationWorker({
      env: { AUTOMATION_EMBEDDED_WORKER_ENABLED: "true" },
      readConfig: () => enabledConfig,
      loadWorker: async () => {
        loadCount += 1;
        if (loadCount === 1) throw providerError;
        return {
          runAutomationWorkerContinuously: async (_config, signal) => {
            receivedSignal = signal;
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        };
      },
      log,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    await vi.waitFor(() => expect(loadCount).toBe(2));
    expect(receivedSignal?.aborted).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      { errorName: "Error", errorCode: "ERR_MODULE_NOT_FOUND" },
      "Embedded automation worker attempt failed; retry scheduled",
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(
      "private module path",
    );
    await handle?.stop();
  });

  it("rejects generically after bounded consecutive failures", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const run = vi.fn(async () => {
      throw new Error("provider secret in response");
    });
    const handle = await startEmbeddedAutomationWorker({
      env: { AUTOMATION_EMBEDDED_WORKER_ENABLED: "true" },
      readConfig: () => enabledConfig,
      loadWorker: async () => ({ runAutomationWorkerContinuously: run }),
      log,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      maxConsecutiveFailures: 3,
    });

    await expect(handle?.completion).rejects.toMatchObject({
      name: "EmbeddedAutomationWorkerUnavailableError",
      message: "",
    });
    expect(run).toHaveBeenCalledTimes(3);
    expect(handle?.getState()).toEqual({
      status: "failed",
      consecutiveFailures: 3,
    });
    expect(log.error).toHaveBeenLastCalledWith(
      { errorName: "Error" },
      "Embedded automation worker unavailable after bounded retries",
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(
      "provider secret in response",
    );
    await expect(handle?.stop()).resolves.toBeUndefined();
  });

  it("cancels a pending retry during shutdown", async () => {
    const run = vi.fn(async () => {
      throw new Error("temporary failure");
    });
    const handle = await startEmbeddedAutomationWorker({
      env: { AUTOMATION_EMBEDDED_WORKER_ENABLED: "true" },
      readConfig: () => enabledConfig,
      loadWorker: async () => ({ runAutomationWorkerContinuously: run }),
      log: { warn: vi.fn(), error: vi.fn() },
      retryBaseDelayMs: 60_000,
      retryMaxDelayMs: 60_000,
    });

    await vi.waitFor(() =>
      expect(handle?.getState().status).toBe("backing_off"),
    );
    await handle?.stop();
    expect(run).toHaveBeenCalledOnce();
    expect(handle?.getState().status).toBe("stopped");
  });

  it("forwards API shutdown to the embedded worker", async () => {
    const shutdown = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const handle = await startEmbeddedAutomationWorker({
      env: { AUTOMATION_EMBEDDED_WORKER_ENABLED: "true" },
      signal: shutdown.signal,
      readConfig: () => enabledConfig,
      loadWorker: async () => ({
        runAutomationWorkerContinuously: async (_config, signal) => {
          receivedSignal = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
      log: { warn: vi.fn(), error: vi.fn() },
    });

    await Promise.resolve();
    shutdown.abort();
    await handle?.completion;
    expect(receivedSignal?.aborted).toBe(true);
  });
});
