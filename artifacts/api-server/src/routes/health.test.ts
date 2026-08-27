import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  checkObjectStorageReadiness: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { execute: state.execute },
}));

vi.mock("drizzle-orm", () => ({
  sql: vi.fn(() => "select 1"),
}));

vi.mock("../lib/gcsReadiness", () => ({
  checkObjectStorageReadiness: state.checkObjectStorageReadiness,
}));

import router from "./health";

describe("health routes", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    state.execute.mockReset();
    state.execute.mockResolvedValue(undefined);
    state.checkObjectStorageReadiness.mockReset();
    state.checkObjectStorageReadiness.mockResolvedValue("verified");
    state.logError.mockReset();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function request(path: string): Promise<globalThis.Response> {
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { log: { error: state.logError } });
      next();
    });
    app.use("/api", router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a disposable TCP listener");
    }
    return fetch(`http://127.0.0.1:${address.port}/api${path}`);
  }

  it("serves liveness without checking persistent dependencies", async () => {
    const response = await request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.checkObjectStorageReadiness).not.toHaveBeenCalled();
  });

  it("reports readiness only after database and storage verification", async () => {
    const response = await request("/readyz");

    expect(response.status).toBe(200);
    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.checkObjectStorageReadiness).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      status: "ready",
      database: "ok",
      objectStorage: "verified",
    });
  });

  it("fails closed when storage verification fails", async () => {
    state.checkObjectStorageReadiness.mockRejectedValue(
      new Error("provider detail that must not be logged"),
    );

    const response = await request("/readyz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not_ready" });
    expect(state.logError).toHaveBeenCalledWith(
      { errorName: "Error" },
      "Readiness check failed",
    );
  });

  it("does not contact storage when the database is unavailable", async () => {
    state.execute.mockRejectedValue(new Error("database unavailable"));

    const response = await request("/readyz");

    expect(response.status).toBe(503);
    expect(state.checkObjectStorageReadiness).not.toHaveBeenCalled();
  });
});
