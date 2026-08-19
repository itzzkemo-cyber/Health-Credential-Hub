import { describe, expect, it } from "vitest";

import { shouldShowShowcaseRoleButtons } from "./showcase-visibility";

describe("showcase visibility", () => {
  it("exposes one-click role buttons only in an explicit showcase build", () => {
    expect(shouldShowShowcaseRoleButtons("showcase")).toBe(true);
    expect(shouldShowShowcaseRoleButtons("production")).toBe(false);
    expect(shouldShowShowcaseRoleButtons("development")).toBe(false);
    expect(shouldShowShowcaseRoleButtons("")).toBe(false);
  });
});
