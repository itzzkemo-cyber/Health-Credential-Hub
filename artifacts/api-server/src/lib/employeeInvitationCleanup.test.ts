import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  candidates: [] as Array<{ id: number }>,
  deleted: [] as Array<{ id: number }>,
  selectProjection: null as Record<string, unknown> | null,
  cleanupWhere: null as unknown,
  cleanupLimit: null as number | null,
  deleteWhere: null as unknown,
  deleteCalls: 0,
  selectCalls: 0,
  loggerError: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  inArray: vi.fn((column: unknown, values: unknown[]) => ({
    operation: "inArray",
    column,
    values,
  })),
  lt: vi.fn((column: unknown, value: unknown) => ({
    operation: "lt",
    column,
    value,
  })),
  or: vi.fn((...conditions: unknown[]) => ({
    operation: "or",
    conditions,
  })),
}));

vi.mock("@workspace/db", () => {
  const employeeInvitationsTable = {
    id: "employeeInvitations.id",
    expiresAt: "employeeInvitations.expiresAt",
    revokedAt: "employeeInvitations.revokedAt",
    acceptedAt: "employeeInvitations.acceptedAt",
  };
  return {
    employeeInvitationsTable,
    db: {
      select: vi.fn((projection: Record<string, unknown>) => {
        state.selectCalls += 1;
        state.selectProjection = projection;
        return {
          from: () => ({
            where: (condition: unknown) => {
              state.cleanupWhere = condition;
              return {
                orderBy: () => ({
                  limit: async (limit: number) => {
                    state.cleanupLimit = limit;
                    return state.candidates;
                  },
                }),
              };
            },
          }),
        };
      }),
      delete: vi.fn(() => {
        state.deleteCalls += 1;
        return {
          where: (condition: unknown) => {
            state.deleteWhere = condition;
            return { returning: async () => state.deleted };
          },
        };
      }),
    },
  };
});

vi.mock("./logger", () => ({
  logger: { error: state.loggerError },
}));

import {
  createEmployeeInvitationCleanupRunner,
  EMPLOYEE_INVITATION_CLEANUP_BATCH_SIZE,
  EMPLOYEE_INVITATION_RETENTION_MS,
  runEmployeeInvitationCleanup,
  startEmployeeInvitationCleanup,
} from "./employeeInvitationCleanup";

describe("employee invitation retention cleanup", () => {
  beforeEach(() => {
    state.candidates = [];
    state.deleted = [];
    state.selectProjection = null;
    state.cleanupWhere = null;
    state.cleanupLimit = null;
    state.deleteWhere = null;
    state.deleteCalls = 0;
    state.selectCalls = 0;
    state.loggerError.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes one bounded ID-only batch 30 days after any terminal timestamp", async () => {
    state.candidates = [{ id: 11 }, { id: 12 }];
    state.deleted = [{ id: 11 }, { id: 12 }];
    const now = new Date("2026-08-28T12:00:00.000Z");

    const count = await runEmployeeInvitationCleanup(now);

    expect(count).toBe(2);
    expect(state.selectProjection).toEqual({ id: "employeeInvitations.id" });
    expect(state.cleanupLimit).toBe(EMPLOYEE_INVITATION_CLEANUP_BATCH_SIZE);
    const cleanupWhere = state.cleanupWhere as {
      operation: string;
      conditions: Array<{ column: string; value: Date }>;
    };
    expect(cleanupWhere.operation).toBe("or");
    expect(
      cleanupWhere.conditions.map((condition) => condition.column),
    ).toEqual([
      "employeeInvitations.expiresAt",
      "employeeInvitations.revokedAt",
      "employeeInvitations.acceptedAt",
    ]);
    expect(
      cleanupWhere.conditions.map((condition) => condition.value.getTime()),
    ).toEqual([
      now.getTime() - EMPLOYEE_INVITATION_RETENTION_MS,
      now.getTime() - EMPLOYEE_INVITATION_RETENTION_MS,
      now.getTime() - EMPLOYEE_INVITATION_RETENTION_MS,
    ]);
    expect(state.deleteWhere).toEqual(
      expect.objectContaining({
        operation: "inArray",
        values: [11, 12],
      }),
    );
  });

  it("does not issue a delete when no retained invitation IDs are eligible", async () => {
    await expect(runEmployeeInvitationCleanup()).resolves.toBe(0);
    expect(state.deleteCalls).toBe(0);
  });

  it("prevents overlapping process-local cleanup runs", async () => {
    let resolveCleanup: ((count: number) => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    const tick = createEmployeeInvitationCleanupRunner(cleanup);

    const first = tick();
    const overlapping = tick();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await overlapping;
    resolveCleanup?.(0);
    await first;

    const next = tick();
    expect(cleanup).toHaveBeenCalledTimes(2);
    resolveCleanup?.(0);
    await next;
  });

  it("logs only a stable PII-free message when cleanup fails", async () => {
    const tick = createEmployeeInvitationCleanupRunner(async () => {
      throw new Error("worker@example.sa token-secret");
    });

    await tick();

    expect(state.loggerError).toHaveBeenCalledWith(
      "Employee invitation retention cleanup failed",
    );
    expect(JSON.stringify(state.loggerError.mock.calls)).not.toContain(
      "worker@example.sa",
    );
    expect(JSON.stringify(state.loggerError.mock.calls)).not.toContain(
      "token-secret",
    );
  });

  it("runs on API startup, repeats hourly, and can be stopped cleanly", async () => {
    vi.useFakeTimers();

    const stop = startEmployeeInvitationCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.selectCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(state.selectCalls).toBe(2);

    stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(state.selectCalls).toBe(2);
  });
});
