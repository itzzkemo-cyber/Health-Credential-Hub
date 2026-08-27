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

const originalDocumentUploadsEnabled = process.env.DOCUMENT_UPLOADS_ENABLED;
const originalEmailEnvironment = {
  EMAIL_ALERTS_DISABLED: process.env.EMAIL_ALERTS_DISABLED,
  EMAIL_FROM: process.env.EMAIL_FROM,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
  NODE_ENV: process.env.NODE_ENV,
};
const originalOcrEnvironment = {
  OCR_ENABLED: process.env.OCR_ENABLED,
  OCR_FACILITY_ALLOWLIST: process.env.OCR_FACILITY_ALLOWLIST,
  OCR_PROVIDER_HOST_ALLOWLIST: process.env.OCR_PROVIDER_HOST_ALLOWLIST,
  AI_INTEGRATIONS_GEMINI_BASE_URL: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
  AI_INTEGRATIONS_GEMINI_API_KEY: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
};

describe("health routes", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  beforeEach(() => {
    state.execute.mockReset();
    state.execute.mockResolvedValue(undefined);
    state.checkObjectStorageReadiness.mockReset();
    state.checkObjectStorageReadiness.mockResolvedValue("verified");
    state.logError.mockReset();
    process.env.EMAIL_ALERTS_DISABLED = "1";
    delete process.env.OCR_ENABLED;
  });

  afterEach(async () => {
    if (originalDocumentUploadsEnabled === undefined) {
      delete process.env.DOCUMENT_UPLOADS_ENABLED;
    } else {
      process.env.DOCUMENT_UPLOADS_ENABLED = originalDocumentUploadsEnabled;
    }
    for (const [name, value] of Object.entries(originalEmailEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [name, value] of Object.entries(originalOcrEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
    process.env.DOCUMENT_UPLOADS_ENABLED = "false";
    const response = await request("/readyz");

    expect(response.status).toBe(200);
    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.checkObjectStorageReadiness).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      status: "ready",
      database: "ok",
      objectStorage: "verified",
      documentUploads: "disabled",
      emailDelivery: "disabled",
      ocr: "disabled",
    });
  });

  it("fails readiness without contacting dependencies when email opt-in is malformed", async () => {
    process.env.EMAIL_ALERTS_DISABLED = "0";
    delete process.env.RESEND_API_KEY;

    const response = await request("/readyz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      emailDelivery: "misconfigured",
    });
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.checkObjectStorageReadiness).not.toHaveBeenCalled();
    expect(state.logError).toHaveBeenCalledWith(
      { errorName: "EmailConfigurationError" },
      "Readiness check failed",
    );
  });

  it("fails readiness without contacting dependencies when OCR opt-in is incomplete", async () => {
    process.env.OCR_ENABLED = "true";

    const response = await request("/readyz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      ocr: "misconfigured",
    });
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.checkObjectStorageReadiness).not.toHaveBeenCalled();
    expect(state.logError).toHaveBeenCalledWith(
      { errorName: "OcrConfigurationError" },
      "Readiness check failed",
    );
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
