import { afterEach, describe, expect, it, vi } from "vitest";
import { employeeLifecycleEvent } from "./events";

const dbMocks = vi.hoisted(() => ({
  automationOutboxTable: { name: "automation_outbox" },
  transaction: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  automationOutboxTable: dbMocks.automationOutboxTable,
  db: { transaction: dbMocks.transaction },
}));

function transaction() {
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { tx: { insert } as never, insert, values, onConflictDoNothing };
}

afterEach(() => {
  delete process.env.AUTOMATION_OUTBOX_ENABLED;
  delete process.env.AUTOMATION_FACILITY_ALLOWLIST;
  vi.resetModules();
});

describe("automation outbox production boundary", () => {
  it("does not write while automation is disabled", async () => {
    const fake = transaction();
    const { enqueueAutomationEvent } = await import("./outbox");

    await enqueueAutomationEvent(
      fake.tx,
      employeeLifecycleEvent(9, 77, 1, "created"),
    );

    expect(fake.insert).not.toHaveBeenCalled();
  });

  it("writes only events for explicitly allowed facilities", async () => {
    process.env.AUTOMATION_OUTBOX_ENABLED = "true";
    process.env.AUTOMATION_FACILITY_ALLOWLIST = "9";
    const fake = transaction();
    const { enqueueAutomationEvent } = await import("./outbox");

    await enqueueAutomationEvent(
      fake.tx,
      employeeLifecycleEvent(10, 88, 1, "created"),
    );
    expect(fake.insert).not.toHaveBeenCalled();

    const event = employeeLifecycleEvent(9, 77, 1, "created");
    await enqueueAutomationEvent(fake.tx, event);

    expect(fake.insert).toHaveBeenCalledWith(dbMocks.automationOutboxTable);
    expect(fake.values).toHaveBeenCalledWith(event);
    expect(fake.onConflictDoNothing).toHaveBeenCalledOnce();
  });
});
