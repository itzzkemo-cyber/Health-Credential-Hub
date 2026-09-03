import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationConfig } from "./config";

const dbMocks = vi.hoisted(() => {
  const claimRows: Array<unknown[]> = [];
  const credentialStates: Array<unknown[]> = [];
  const expirySnapshots: Array<unknown[]> = [];
  const expirySnapshotFailures: Error[] = [];
  const expiryPages: Array<unknown[]> = [];
  const updateReturns: Array<unknown[]> = [];
  const updateSets: Array<Record<string, unknown>> = [];
  const eq = vi.fn((left: unknown, right: unknown) => ({
    operation: "eq",
    left,
    right,
  }));
  const gt = vi.fn((left: unknown, right: unknown) => ({
    operation: "gt",
    left,
    right,
  }));
  const inArray = vi.fn((column: unknown, values: readonly unknown[]) => ({
    operation: "inArray",
    column,
    values,
  }));

  const terminal = (rows: unknown[] = []) => ({
    for: vi.fn(async () => rows),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  });

  const orderedRows = (fields?: Record<string, unknown>): unknown[] => {
    if (fields?.credential) return expiryPages.shift() ?? [];
    if (fields?.id === "credential.id") {
      const failure = expirySnapshotFailures.shift();
      if (failure) throw failure;
      return expirySnapshots.shift() ?? [];
    }
    if (fields == null) return claimRows.shift() ?? [];
    return [];
  };

  const whereChain = (
    fields: Record<string, unknown> | undefined,
    joined: boolean,
  ) => ({
    limit: vi.fn(() =>
      terminal(
        joined && fields && "credentialType" in fields
          ? (credentialStates.shift() ?? [])
          : [],
      ),
    ),
    orderBy: vi.fn(() => ({
      limit: vi.fn(() => terminal(orderedRows(fields))),
    })),
  });

  const select = vi.fn((fields?: Record<string, unknown>) => ({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => whereChain(fields, true)),
      })),
      where: vi.fn(() => whereChain(fields, false)),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updateSets.push(values);
      return {
        where: vi.fn(() => ({
          returning: vi.fn(async () => updateReturns.shift() ?? []),
        })),
      };
    }),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(async () => undefined),
    })),
  }));
  const deleteFrom = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback({ select, update, insert }),
  );

  return {
    claimRows,
    credentialStates,
    deleteFrom,
    eq,
    expiryPages,
    expirySnapshotFailures,
    expirySnapshots,
    gt,
    inArray,
    insert,
    select,
    transaction,
    update,
    updateReturns,
    updateSets,
  };
});

const webhookMocks = vi.hoisted(() => ({
  buildAutomationEnvelope: vi.fn(),
  deliverAutomationWebhook: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  automationDeliveryLogTable: {
    eventId: "delivery.eventId",
  },
  automationOutboxTable: {
    attempts: "outbox.attempts",
    availableAt: "outbox.availableAt",
    createdAt: "outbox.createdAt",
    discardedAt: "outbox.discardedAt",
    facilityId: "outbox.facilityId",
    id: "outbox.id",
    lockedAt: "outbox.lockedAt",
    processedAt: "outbox.processedAt",
  },
  credentialsTable: {
    deletedAt: "credential.deletedAt",
    employeeId: "credential.employeeId",
    expiryDate: "credential.expiryDate",
    id: "credential.id",
    isVerified: "credential.isVerified",
    type: "credential.type",
  },
  db: {
    delete: dbMocks.deleteFrom,
    insert: dbMocks.insert,
    select: dbMocks.select,
    transaction: dbMocks.transaction,
  },
  usersTable: {
    facilityId: "user.facilityId",
    id: "user.id",
    isActive: "user.isActive",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ operation: "and", conditions })),
  asc: vi.fn((column: unknown) => ({ operation: "asc", column })),
  desc: vi.fn((column: unknown) => ({ operation: "desc", column })),
  eq: dbMocks.eq,
  gt: dbMocks.gt,
  gte: vi.fn((left: unknown, right: unknown) => ({
    operation: "gte",
    left,
    right,
  })),
  inArray: dbMocks.inArray,
  isNotNull: vi.fn((column: unknown) => ({ operation: "isNotNull", column })),
  isNull: vi.fn((column: unknown) => ({ operation: "isNull", column })),
  lt: vi.fn((left: unknown, right: unknown) => ({
    operation: "lt",
    left,
    right,
  })),
  lte: vi.fn((left: unknown, right: unknown) => ({
    operation: "lte",
    left,
    right,
  })),
  or: vi.fn((...conditions: unknown[]) => ({ operation: "or", conditions })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    operation: "sql",
    strings,
    values,
  })),
}));

vi.mock("../logger", () => ({
  logger: loggerMocks,
}));

vi.mock("./webhook", () => ({
  buildAutomationEnvelope: webhookMocks.buildAutomationEnvelope,
  deliverAutomationWebhook: webhookMocks.deliverAutomationWebhook,
}));

const config: AutomationConfig = {
  batchSize: 5,
  enabled: true,
  facilityAllowlist: [7],
  headerAuthSecret: Buffer.alloc(32, 8).toString("base64"),
  lockTimeoutMs: 60_000,
  maxAttempts: 3,
  pendingMaxAgeDays: 7,
  pollIntervalMs: 1_000,
  requirePublicAddress: false,
  retentionDays: 30,
  timeoutMs: 5_000,
};

class InspectableAbortSignal {
  aborted = false;
  readonly listeners = new Set<(event: Event) => void>();
  maximumListenerCount = 0;

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (type !== "abort") return;
    this.listeners.add(listener);
    this.maximumListenerCount = Math.max(
      this.maximumListenerCount,
      this.listeners.size,
    );
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    if (type === "abort") this.listeners.delete(listener);
  }

  abort(): void {
    this.aborted = true;
    for (const listener of [...this.listeners]) {
      listener.call(this, new Event("abort"));
    }
    this.listeners.clear();
  }
}

async function waitForPollTimer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await Promise.resolve();
    if (vi.getTimerCount() === 1) return;
  }
  throw new Error("automation worker did not enter its polling wait");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  dbMocks.claimRows.length = 0;
  dbMocks.credentialStates.length = 0;
  dbMocks.expiryPages.length = 0;
  dbMocks.expirySnapshotFailures.length = 0;
  dbMocks.expirySnapshots.length = 0;
  dbMocks.updateReturns.length = 0;
  dbMocks.updateSets.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function queueCredentialLifecycleClaim(attempt = 1): void {
  const selectedRow = {
    id: "11111111-1111-4111-8111-111111111111",
    facilityId: 7,
    credentialId: 42,
    eventType: "credential.lifecycle_changed",
    deduplicationKey: "credential.lifecycle_changed:42:2:deleted",
    payload: { change: "deleted" },
    attempts: attempt - 1,
    availableAt: new Date("2026-09-03T00:00:00.000Z"),
    lockedAt: null,
    processedAt: null,
    discardedAt: null,
    lastErrorCode: null,
    createdAt: new Date("2026-09-03T00:00:00.000Z"),
  };
  dbMocks.claimRows.push([selectedRow]);
  dbMocks.updateReturns.push([
    {
      ...selectedRow,
      attempts: attempt,
      lockedAt: new Date("2026-09-03T00:01:00.000Z"),
    },
  ]);
  dbMocks.updateReturns.push([{ id: selectedRow.id }]);
  webhookMocks.buildAutomationEnvelope.mockReturnValue({
    id: selectedRow.id,
    type: selectedRow.eventType,
    occurredAt: selectedRow.createdAt.toISOString(),
    facilityId: selectedRow.facilityId,
    data: selectedRow.payload,
  });
}

describe("automation worker tenant boundary", () => {
  it("scopes expiry scan, maintenance, claim, and cleanup to the facility allowlist", async () => {
    const { runAutomationWorkerCycle } = await import("./worker");

    await expect(runAutomationWorkerCycle(config)).resolves.toBe(0);

    expect(dbMocks.inArray).toHaveBeenCalledTimes(5);
    for (const [, facilities] of dbMocks.inArray.mock.calls) {
      expect(facilities).toEqual([7]);
      expect(facilities).not.toContain(99);
    }
  });

  it("does not dispatch a credential lifecycle event after its owner moves to another facility", async () => {
    queueCredentialLifecycleClaim();
    dbMocks.credentialStates.push([
      {
        credentialType: "BLS",
        deletedAt: null,
        employeeId: 18,
        expiryDate: "2027-09-03",
        isVerified: false,
        facilityId: 99,
        employeeActive: true,
      },
    ]);
    webhookMocks.deliverAutomationWebhook.mockResolvedValue({ ok: true });
    const { runAutomationWorkerCycle } = await import("./worker");

    await expect(
      runAutomationWorkerCycle({ ...config, batchSize: 1 }),
    ).resolves.toBe(1);

    expect(dbMocks.eq).toHaveBeenCalledWith("credential.id", 42);
    expect(dbMocks.eq).toHaveBeenCalledWith("user.facilityId", 7);
    expect(webhookMocks.deliverAutomationWebhook).not.toHaveBeenCalled();
  });

  it("dispatches a deletion lifecycle event when the soft-deleted credential still belongs to the event facility", async () => {
    queueCredentialLifecycleClaim();
    dbMocks.credentialStates.push([
      {
        credentialType: "BLS",
        deletedAt: new Date("2026-09-03T00:00:00.000Z"),
        employeeId: 18,
        expiryDate: "2027-09-03",
        isVerified: false,
        facilityId: 7,
        employeeActive: false,
      },
    ]);
    webhookMocks.deliverAutomationWebhook.mockResolvedValue({ ok: true });
    const { runAutomationWorkerCycle } = await import("./worker");

    await expect(
      runAutomationWorkerCycle({ ...config, batchSize: 1 }),
    ).resolves.toBe(1);

    expect(webhookMocks.deliverAutomationWebhook).toHaveBeenCalledTimes(1);
  });

  it("scans more than one expiry page after an independent one-shot restart", async () => {
    const expiryDate = new Date().toISOString().slice(0, 10);
    const rows = Array.from({ length: 251 }, (_, index) => ({
      credential: {
        id: index + 1,
        employeeId: index + 10,
        expiryDate,
        type: "BLS",
      },
      facilityId: 7,
    }));
    dbMocks.expirySnapshots.push([{ id: 251 }], [{ id: 251 }]);
    dbMocks.expiryPages.push(
      rows.slice(0, 250),
      rows.slice(250),
      rows.slice(0, 250),
      rows.slice(250),
    );

    const firstProcess = await import("./worker");
    await expect(firstProcess.runAutomationWorkerCycle(config)).resolves.toBe(
      0,
    );
    vi.resetModules();
    const restartedProcess = await import("./worker");
    await expect(
      restartedProcess.runAutomationWorkerCycle(config),
    ).resolves.toBe(0);

    const pageCursors = dbMocks.gt.mock.calls
      .filter(([column]) => column === "credential.id")
      .map(([, cursor]) => cursor);
    expect(pageCursors).toEqual([0, 250, 0, 250]);
    expect(dbMocks.insert).toHaveBeenCalledTimes(502);
  });

  it("scans expiries immediately and then at most once per hour for a continuous config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    dbMocks.expirySnapshots.push([], []);
    const { runAutomationWorkerCycle } = await import("./worker");

    await expect(runAutomationWorkerCycle(config)).resolves.toBe(0);
    await expect(runAutomationWorkerCycle(config)).resolves.toBe(0);
    vi.setSystemTime(new Date("2026-09-03T00:59:59.999Z"));
    await expect(runAutomationWorkerCycle(config)).resolves.toBe(0);

    const expirySnapshotQueries = () =>
      dbMocks.select.mock.calls.filter(
        ([fields]) => fields?.id === "credential.id",
      ).length;
    expect(expirySnapshotQueries()).toBe(1);

    vi.setSystemTime(new Date("2026-09-03T01:00:00.000Z"));
    await expect(runAutomationWorkerCycle(config)).resolves.toBe(0);
    expect(expirySnapshotQueries()).toBe(2);
  });

  it("keeps the expiry-scan cadence isolated between tenant configurations", async () => {
    dbMocks.expirySnapshots.push([], []);
    const secondConfig: AutomationConfig = {
      ...config,
      facilityAllowlist: [99],
    };
    const { runAutomationWorkerCycle } = await import("./worker");

    await expect(runAutomationWorkerCycle(config)).resolves.toBe(0);
    await expect(runAutomationWorkerCycle(secondConfig)).resolves.toBe(0);
    await expect(runAutomationWorkerCycle(config)).resolves.toBe(0);

    const expirySnapshotQueries = dbMocks.select.mock.calls.filter(
      ([fields]) => fields?.id === "credential.id",
    );
    expect(expirySnapshotQueries).toHaveLength(2);
    expect(dbMocks.inArray.mock.calls).toContainEqual(["user.facilityId", [7]]);
    expect(dbMocks.inArray.mock.calls).toContainEqual([
      "user.facilityId",
      [99],
    ]);
  });

  it("does not postpone an expiry rescan after a failed scan", async () => {
    dbMocks.expirySnapshotFailures.push(new Error("database unavailable"));
    dbMocks.expirySnapshots.push([]);
    const { runAutomationWorkerCycle } = await import("./worker");

    await expect(runAutomationWorkerCycle(config)).rejects.toThrow(
      "database unavailable",
    );
    await expect(runAutomationWorkerCycle(config)).resolves.toBe(0);

    const expirySnapshotQueries = dbMocks.select.mock.calls.filter(
      ([fields]) => fields?.id === "credential.id",
    );
    expect(expirySnapshotQueries).toHaveLength(2);
  });

  it.each(["http_401", "http_403", "invalid_acknowledgement"])(
    "keeps a receiver contract failure %s pending after its first attempt",
    async (errorCode) => {
      queueCredentialLifecycleClaim(1);
      dbMocks.credentialStates.push([
        {
          credentialType: "BLS",
          deletedAt: null,
          employeeId: 18,
          expiryDate: "2027-09-03",
          isVerified: false,
          facilityId: 7,
          employeeActive: true,
        },
      ]);
      webhookMocks.deliverAutomationWebhook.mockResolvedValue({
        ok: false,
        errorCode,
        permanent: false,
      });
      const { runAutomationWorkerCycle } = await import("./worker");

      await expect(
        runAutomationWorkerCycle({ ...config, batchSize: 1, maxAttempts: 8 }),
      ).resolves.toBe(1);

      const failureUpdate = dbMocks.updateSets.find(
        (values) => values.lastErrorCode === errorCode,
      );
      expect(failureUpdate).toMatchObject({
        lockedAt: null,
        lastErrorCode: errorCode,
        availableAt: expect.any(Date),
      });
      expect(failureUpdate).not.toHaveProperty("discardedAt");
      expect(loggerMocks.error).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: "11111111-1111-4111-8111-111111111111",
          attempt: 1,
          errorCode,
        }),
        "Automation receiver contract failure; bounded retry scheduled",
      );
    },
  );

  it("discards a receiver contract failure only after its separate bounded retry budget", async () => {
    queueCredentialLifecycleClaim(3);
    dbMocks.credentialStates.push([
      {
        credentialType: "BLS",
        deletedAt: null,
        employeeId: 18,
        expiryDate: "2027-09-03",
        isVerified: false,
        facilityId: 7,
        employeeActive: true,
      },
    ]);
    webhookMocks.deliverAutomationWebhook.mockResolvedValue({
      ok: false,
      errorCode: "http_401",
      permanent: false,
    });
    const { runAutomationWorkerCycle } = await import("./worker");

    await expect(
      runAutomationWorkerCycle({ ...config, batchSize: 1, maxAttempts: 8 }),
    ).resolves.toBe(1);

    const failureUpdate = dbMocks.updateSets.find(
      (values) => values.lastErrorCode === "http_401",
    );
    expect(failureUpdate).toMatchObject({
      lockedAt: null,
      lastErrorCode: "http_401",
      discardedAt: expect.any(Date),
    });
    expect(failureUpdate).not.toHaveProperty("availableAt");
    expect(loggerMocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 3, errorCode: "http_401" }),
      "Automation receiver contract failure exhausted bounded retries",
    );
  });

  it("keeps at most one abort listener while polling continuously", async () => {
    vi.useFakeTimers();
    const signal = new InspectableAbortSignal();
    const { runAutomationWorkerContinuously } = await import("./worker");

    const running = runAutomationWorkerContinuously(
      config,
      signal as unknown as AbortSignal,
    );
    await waitForPollTimer();
    await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
    await waitForPollTimer();
    await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
    await waitForPollTimer();
    signal.abort();
    await running;

    expect(signal.maximumListenerCount).toBe(1);
    expect(signal.listeners.size).toBe(0);
  });

  it("fails closed after bounded consecutive cycle failures and resets after success", async () => {
    vi.useFakeTimers();
    const signal = new InspectableAbortSignal();
    const providerError = Object.assign(
      new Error("secret-bearing provider response"),
      { code: "ECONNRESET" },
    );
    const runCycle = vi
      .fn<(workerConfig: AutomationConfig) => Promise<number>>()
      .mockRejectedValueOnce(providerError)
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(providerError)
      .mockRejectedValueOnce(providerError)
      .mockRejectedValueOnce(providerError);
    const { runAutomationWorkerContinuously } = await import("./worker");

    const running = runAutomationWorkerContinuously(
      config,
      signal as unknown as AbortSignal,
      { maxConsecutiveFailures: 3, runCycle },
    );
    const rejection = expect(running).rejects.toMatchObject({
      name: "AutomationWorkerUnavailableError",
      message: "",
    });

    for (let completedCycle = 1; completedCycle < 6; completedCycle += 1) {
      await waitForPollTimer();
      expect(runCycle).toHaveBeenCalledTimes(completedCycle);
      await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
    }
    await rejection;

    expect(runCycle).toHaveBeenCalledTimes(6);
    expect(
      loggerMocks.error.mock.calls.map(
        ([fields]) =>
          (fields as { consecutiveFailures: number }).consecutiveFailures,
      ),
    ).toEqual([1, 2, 1, 2, 3]);
    expect(loggerMocks.error).toHaveBeenLastCalledWith(
      {
        errorName: "Error",
        errorCode: "ECONNRESET",
        consecutiveFailures: 3,
      },
      "Automation worker unavailable after bounded consecutive cycle failures",
    );
    expect(JSON.stringify(loggerMocks.error.mock.calls)).not.toContain(
      "secret-bearing provider response",
    );
    expect(signal.listeners.size).toBe(0);
  });
});
