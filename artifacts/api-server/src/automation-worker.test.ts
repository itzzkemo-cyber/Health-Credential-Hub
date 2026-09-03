import { describe, expect, it } from "vitest";

import { readAutomationWorkerMode } from "./automation-worker";

describe("automation worker process configuration", () => {
  it("keeps one-shot execution as the local default", () => {
    expect(readAutomationWorkerMode({})).toBe("once");
  });

  it.each(["once", "continuous"] as const)(
    "accepts the supported %s mode",
    (mode) => {
      expect(readAutomationWorkerMode({ AUTOMATION_WORKER_MODE: mode })).toBe(
        mode,
      );
    },
  );

  it("rejects an ambiguous worker mode", () => {
    expect(() =>
      readAutomationWorkerMode({ AUTOMATION_WORKER_MODE: "daemon" }),
    ).toThrow("AUTOMATION_WORKER_MODE must be once or continuous");
  });
});
