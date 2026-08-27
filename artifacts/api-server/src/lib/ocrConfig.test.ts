import { describe, expect, it } from "vitest";

import {
  getOcrOperationalReadiness,
  isOcrEnabledForFacility,
  readOcrConfig,
} from "./ocrConfig";

const validEnv = {
  OCR_ENABLED: "true",
  OCR_FACILITY_ALLOWLIST: "10,20,10",
  OCR_PROVIDER_HOST_ALLOWLIST: "vertex.example.sa",
  AI_INTEGRATIONS_GEMINI_BASE_URL: "https://vertex.example.sa/v1",
  AI_INTEGRATIONS_GEMINI_API_KEY: "secret-from-runtime",
} satisfies NodeJS.ProcessEnv;

describe("OCR release gate", () => {
  it("fails closed when no explicit opt-in exists", () => {
    expect(readOcrConfig({})).toEqual({
      enabled: false,
      facilityAllowlist: [],
    });
    expect(getOcrOperationalReadiness({})).toBe("disabled");
  });

  it("enables only explicitly allowlisted facilities", () => {
    const config = readOcrConfig(validEnv);

    expect(config).toEqual({ enabled: true, facilityAllowlist: [10, 20] });
    expect(isOcrEnabledForFacility(10, config)).toBe(true);
    expect(isOcrEnabledForFacility(30, config)).toBe(false);
    expect(getOcrOperationalReadiness(validEnv)).toBe("configured");
  });

  it.each(["1", "yes", "enabled"])(
    "reports an unknown %s flag as misconfigured",
    (value) => {
      expect(getOcrOperationalReadiness({ OCR_ENABLED: value })).toBe(
        "misconfigured",
      );
    },
  );

  it("rejects enabled OCR without an explicit facility list", () => {
    expect(() =>
      readOcrConfig({ ...validEnv, OCR_FACILITY_ALLOWLIST: "" }),
    ).toThrow("OCR_FACILITY_ALLOWLIST");
  });

  it.each(["*", "0", "-1", "10,all"])(
    "rejects unsafe facility allowlist value %s",
    (value) => {
      expect(() =>
        readOcrConfig({ ...validEnv, OCR_FACILITY_ALLOWLIST: value }),
      ).toThrow("positive integer IDs");
    },
  );

  it("requires the configured provider host to match an exact allowlist entry", () => {
    expect(() =>
      readOcrConfig({
        ...validEnv,
        OCR_PROVIDER_HOST_ALLOWLIST: "other.example.sa",
      }),
    ).toThrow("not in OCR_PROVIDER_HOST_ALLOWLIST");
  });

  it.each([
    "http://vertex.example.sa/v1",
    "https://user@vertex.example.sa/v1",
    "https://vertex.example.sa/v1?redirect=attacker.example",
  ])("rejects unsafe provider URL %s", (baseUrl) => {
    expect(() =>
      readOcrConfig({
        ...validEnv,
        AI_INTEGRATIONS_GEMINI_BASE_URL: baseUrl,
      }),
    ).toThrow("must use HTTPS");
  });
});
