import { describe, expect, it, vi } from "vitest";

import { copyTextToClipboard } from "./clipboard";

describe("copyTextToClipboard", () => {
  it("copies through the provided Clipboard API writer", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await expect(
      copyTextToClipboard("sensitive-value", { writeText }),
    ).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("sensitive-value");
  });

  it("fails closed when Clipboard API access is unavailable", async () => {
    await expect(copyTextToClipboard("sensitive-value", undefined)).resolves.toBe(
      false,
    );
  });

  it("reports a rejected clipboard write without leaking the value", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));

    await expect(
      copyTextToClipboard("sensitive-value", { writeText }),
    ).resolves.toBe(false);
  });
});
