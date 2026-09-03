import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeAutomationWorkerHealthServer,
  createAutomationWorkerHealthServer,
  listenForAutomationWorkerHealth,
  type AutomationWorkerHealthState,
} from "./workerHealth";

const openServers: ReturnType<typeof createAutomationWorkerHealthServer>[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(closeAutomationWorkerHealthServer),
  );
});

async function startServer(options?: {
  state?: AutomationWorkerHealthState;
  probeDatabase?: () => Promise<void>;
  releaseSha?: string;
}) {
  let state = options?.state ?? "ready";
  const log = { error: vi.fn() };
  const server = createAutomationWorkerHealthServer({
    getState: () => state,
    probeDatabase: options?.probeDatabase ?? (async () => undefined),
    log,
    releaseSha: options?.releaseSha,
  });
  openServers.push(server);
  await listenForAutomationWorkerHealth(server, 0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  return {
    log,
    setState(nextState: AutomationWorkerHealthState) {
      state = nextState;
    },
    url: `http://127.0.0.1:${port}`,
  };
}

describe("dedicated automation worker health listener", () => {
  it("reports fixed liveness and includes only a validated release SHA", async () => {
    const runtime = await startServer({ releaseSha: "a".repeat(40) });

    const response = await fetch(`${runtime.url}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      releaseSha: "a".repeat(40),
    });
  });

  it("fails readiness while starting without touching the database", async () => {
    const probeDatabase = vi.fn(async () => undefined);
    const runtime = await startServer({ state: "starting", probeDatabase });

    const response = await fetch(`${runtime.url}/readyz`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "not_ready" });
    expect(probeDatabase).not.toHaveBeenCalled();
  });

  it("reports readiness only after an operation-critical database probe", async () => {
    const probeDatabase = vi.fn(async () => undefined);
    const runtime = await startServer({ probeDatabase });

    const response = await fetch(`${runtime.url}/readyz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      database: "ok",
      worker: "running",
    });
    const cachedResponse = await fetch(`${runtime.url}/readyz`);
    expect(cachedResponse.status).toBe(200);
    expect(probeDatabase).toHaveBeenCalledTimes(1);
  });

  it("fails closed without returning a database error or secret", async () => {
    const runtime = await startServer({
      probeDatabase: async () => {
        throw new Error("postgres password=do-not-return");
      },
    });

    const response = await fetch(`${runtime.url}/readyz`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe('{"status":"not_ready"}');
    expect(body).not.toContain("do-not-return");
    expect(runtime.log.error).toHaveBeenCalledWith(
      { errorName: "Error" },
      "Automation worker readiness check failed",
    );
  });

  it("withdraws liveness during shutdown and exposes no other routes", async () => {
    const runtime = await startServer();
    runtime.setState("stopping");

    const [health, unknown, invalidMethod] = await Promise.all([
      fetch(`${runtime.url}/healthz`),
      fetch(`${runtime.url}/metrics`),
      fetch(`${runtime.url}/readyz`, { method: "POST" }),
    ]);

    expect(health.status).toBe(503);
    expect(unknown.status).toBe(404);
    expect(invalidMethod.status).toBe(405);
    expect(invalidMethod.headers.get("allow")).toBe("GET, HEAD");
  });
});
