import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { safeErrorLogFields, safeErrorSerializers } from "./safeError";

function captureLog(errorKey: "err" | "error", error: unknown): string {
  let output = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const testLogger = pino({ serializers: safeErrorSerializers }, sink);
  testLogger.error({ [errorKey]: error }, "operation failed");
  return output;
}

describe("safe error logging", () => {
  it("keeps only a bounded database error classification", () => {
    const error = Object.assign(
      new Error(
        "duplicate employee staff@example.sa at facilities/7/private.pdf",
      ),
      {
        code: "23505",
        detail: "Key (email)=(staff@example.sa) already exists",
        query: "insert into users values ('staff@example.sa')",
      },
    );

    const output = captureLog("err", error);
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed.err).toEqual({ errorName: "Error", errorCode: "23505" });
    expect(output).not.toContain("staff@example.sa");
    expect(output).not.toContain("facilities/7/private.pdf");
    expect(output).not.toContain("insert into users");
  });

  it("does not serialize provider requests, object paths, or signed URLs", () => {
    const providerError = {
      name: "StorageProviderError",
      code: "AccessDenied",
      email: "employee@example.sa",
      objectPath: "/objects/facility-4/private.pdf",
      request: {
        url: "https://storage.example.sa/private.pdf?X-Amz-Signature=secret",
        headers: { authorization: "Bearer secret" },
      },
    };

    const output = captureLog("error", providerError);
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed.error).toEqual({
      errorName: "StorageProviderError",
      errorCode: "AccessDenied",
    });
    expect(output).not.toContain("employee@example.sa");
    expect(output).not.toContain("/objects/");
    expect(output).not.toContain("X-Amz-Signature");
    expect(output).not.toContain("Bearer secret");
  });

  it("drops unbounded names and codes instead of echoing sensitive text", () => {
    expect(
      safeErrorLogFields({
        name: "failure for staff@example.sa",
        code: "https://storage.example.sa/file?signature=secret",
      }),
    ).toEqual({ errorName: "UnknownError" });
  });
});
