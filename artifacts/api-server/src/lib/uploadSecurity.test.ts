import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  uploadGrantsTable: {},
}));

import {
  checkMalwareScannerReadiness,
  checkUploadSecurityReadiness,
  CONTENT_SHA256_METADATA_KEY,
  hasAllowedUploadSignature,
  MalwareDetectedError,
  MalwareQuarantineCleanupError,
  MalwareQuarantineRemnantError,
  MalwareScanBusyError,
  MalwareScanUnavailableError,
  MAX_UPLOAD_BYTES,
  processUploadSecurity,
  scanUploadForMalware,
  UploadSecurityRejectedError,
  UploadSecurityUnavailableError,
  validateUploadedObject,
} from "./uploadSecurity";
import type { StoredObjectFile, StoredObjectMetadata } from "./objectStorage";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  "base64",
);
const TINY_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
  "base64",
);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const dataBytes = Buffer.from(data);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(dataBytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, dataBytes])));
  return Buffer.concat([length, typeBytes, dataBytes, checksum]);
}

function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return ihdr;
}

function animatedPng(): Buffer {
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(2, 0);
  const frameControl = (sequence: number) => {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence, 0);
    control.writeUInt32BE(1, 4);
    control.writeUInt32BE(1, 8);
    control.writeUInt16BE(1, 20);
    control.writeUInt16BE(10, 22);
    return control;
  };
  const firstFrame = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  const secondFrame = deflateSync(Buffer.from([0, 0, 0, 255, 255]));
  const frameData = Buffer.alloc(4 + secondFrame.length);
  frameData.writeUInt32BE(2, 0);
  secondFrame.copy(frameData, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", pngHeader(1, 1)),
    pngChunk("acTL", animationControl),
    pngChunk("fcTL", frameControl(0)),
    pngChunk("IDAT", firstFrame),
    pngChunk("fcTL", frameControl(1)),
    pngChunk("fdAT", frameData),
    pngChunk("IEND"),
  ]);
}

function storedFile(
  bytes: Buffer,
  contentType: string,
  metadata: Record<string, string> = {},
): StoredObjectFile & { setMetadata: ReturnType<typeof vi.fn> } {
  const setMetadata = vi.fn().mockResolvedValue(undefined);
  return {
    name: "uploads/test",
    exists: vi.fn().mockResolvedValue([true]),
    getMetadata: vi.fn().mockResolvedValue([
      {
        contentType,
        size: bytes.length,
        metadata,
      } satisfies StoredObjectMetadata,
    ]),
    setMetadata,
    createReadStream: vi.fn().mockResolvedValue(Readable.from(bytes)),
    download: vi.fn().mockResolvedValue([bytes]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function uploadGrant(
  status: "pending" | "processing" | "processed",
  processedSha256: string | null,
): NonNullable<Parameters<typeof validateUploadedObject>[1]> {
  const processing = status === "processing";
  const processed = status === "processed";
  return {
    id: 19,
    objectPath: "/objects/uploads/f3fddc5a-9315-4b7b-8e7c-8ac98bc9f6c5",
    requestedBy: 7,
    fileName: "credential.jpg",
    declaredSize: TINY_JPEG.length,
    declaredContentType: "image/jpeg",
    status,
    processingToken: processing ? "7ddf75bb-4a6f-47f9-987f-21c946624859" : null,
    processingStartedAt:
      processing || processed ? new Date("2026-08-27T00:00:00.000Z") : null,
    processedAt: processed ? new Date("2026-08-27T00:00:01.000Z") : null,
    processedSha256,
    expiresAt: new Date("2026-08-27T00:15:00.000Z"),
    claimedAt: null,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
  };
}

describe("credential upload content verification", () => {
  it.each([
    ["image/png", TINY_PNG],
    ["image/jpeg", TINY_JPEG],
  ])("accepts the real signature for %s", (contentType, bytes) => {
    expect(hasAllowedUploadSignature(bytes, contentType)).toBe(true);
  });

  it.each(["image/jpg", "application/pdf", "image/webp", "image/gif"])(
    "does not admit the legacy %s type",
    (contentType) => {
      expect(hasAllowedUploadSignature(TINY_JPEG, contentType)).toBe(false);
    },
  );

  it("rejects active content renamed as an image", () => {
    expect(
      hasAllowedUploadSignature(
        Buffer.from("<script>alert(1)</script>"),
        "image/png",
      ),
    ).toBe(false);
  });

  it("records a SHA-256 hash while preserving existing metadata", async () => {
    const bytes = TINY_JPEG;
    const file = storedFile(bytes, "image/jpeg", { existing: "value" });

    const result = await validateUploadedObject(file);

    expect(result.bytes).toEqual(bytes);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(file.setMetadata).toHaveBeenCalledWith({
      metadata: {
        existing: "value",
        [CONTENT_SHA256_METADATA_KEY]: result.sha256,
      },
    });
  });

  it("detects content replacement after a hash was recorded", async () => {
    const bytes = TINY_JPEG;
    const file = storedFile(bytes, "image/jpeg", {
      [CONTENT_SHA256_METADATA_KEY]: "0".repeat(64),
    });

    await expect(validateUploadedObject(file)).rejects.toThrow(
      /integrity hash mismatch/,
    );
  });

  it.each(["pending", "processing"] as const)(
    "does not expose a %s grant to credential or OCR consumers",
    async (status) => {
      const file = storedFile(TINY_JPEG, "image/jpeg");

      await expect(
        validateUploadedObject(file, uploadGrant(status, null)),
      ).rejects.toThrow(/has not completed security processing/);
      expect(file.getMetadata).not.toHaveBeenCalled();
    },
  );

  it("accepts only bytes bound to the processed grant hash", async () => {
    const expectedHash = createHash("sha256").update(TINY_JPEG).digest("hex");
    const file = storedFile(TINY_JPEG, "image/jpeg");

    await expect(
      validateUploadedObject(file, uploadGrant("processed", expectedHash)),
    ).resolves.toEqual(
      expect.objectContaining({ sha256: expectedHash, bytes: TINY_JPEG }),
    );

    await expect(
      validateUploadedObject(
        storedFile(TINY_JPEG, "image/jpeg"),
        uploadGrant("processed", "0".repeat(64)),
      ),
    ).rejects.toThrow(/does not match its processed upload grant/);
  });
});

describe("controlled raster sanitizer", () => {
  const rasterEnv = { UPLOAD_SECURITY_PROVIDER: "raster-sanitizer" };

  it.each([
    ["image/png" as const, TINY_PNG],
    ["image/jpeg" as const, TINY_JPEG],
  ])("re-encodes %s as a bounded fresh JPEG", async (contentType, bytes) => {
    const result = await processUploadSecurity(bytes, contentType, {
      env: rasterEnv,
    });

    expect(result.contentType).toBe("image/jpeg");
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.bytes.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
    expect(hasAllowedUploadSignature(result.bytes, result.contentType)).toBe(
      true,
    );
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("strips JPEG metadata and appended polyglot bytes", async () => {
    const exifPayload = Buffer.from(
      "Exif\0\0SYNTHETIC-PRIVATE-METADATA",
      "ascii",
    );
    const app1Length = Buffer.alloc(2);
    app1Length.writeUInt16BE(exifPayload.length + 2);
    const marker = Buffer.concat([
      Buffer.from([0xff, 0xe1]),
      app1Length,
      exifPayload,
    ]);
    const input = Buffer.concat([
      TINY_JPEG.subarray(0, 2),
      marker,
      TINY_JPEG.subarray(2),
      Buffer.from("<script>POLYGLOT-TRAILER</script>", "ascii"),
    ]);

    const result = await processUploadSecurity(input, "image/jpeg", {
      env: rasterEnv,
    });

    expect(result.bytes.includes(Buffer.from("Exif\0\0", "ascii"))).toBe(false);
    expect(
      result.bytes.includes(Buffer.from("POLYGLOT-TRAILER", "ascii")),
    ).toBe(false);
  });

  it.each([
    [
      "a malformed raster",
      Buffer.concat([TINY_PNG.subarray(0, 8), Buffer.from("broken")]),
      "image/png",
    ],
    ["a MIME mismatch", TINY_PNG, "image/jpeg"],
    ["image/jpg", TINY_JPEG, "image/jpg"],
    ["a non-raster type", Buffer.from("%PDF-1.7"), "application/pdf"],
  ])("rejects %s", async (_caseName, bytes, contentType) => {
    await expect(
      processUploadSecurity(bytes, contentType, { env: rasterEnv }),
    ).rejects.toBeInstanceOf(UploadSecurityRejectedError);
  });

  it("rejects a declared pixel bomb before persistence", async () => {
    const row = deflateSync(Buffer.from([0, 255, 255, 255, 255]));
    const bomb = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", pngHeader(4_001, 3_000)),
      pngChunk("IDAT", row),
      pngChunk("IEND"),
    ]);

    await expect(
      processUploadSecurity(bomb, "image/png", { env: rasterEnv }),
    ).rejects.toBeInstanceOf(UploadSecurityRejectedError);
  });

  it("rejects animated PNG input", async () => {
    await expect(
      processUploadSecurity(animatedPng(), "image/png", { env: rasterEnv }),
    ).rejects.toBeInstanceOf(UploadSecurityRejectedError);
  });

  it("times out a stalled sanitizer after the configured production boundary", async () => {
    await expect(
      processUploadSecurity(TINY_PNG, "image/png", {
        env: rasterEnv,
        sanitizerTimeoutMs: 5,
        rasterSanitizer: async () => new Promise<Buffer>(() => {}),
      }),
    ).rejects.toBeInstanceOf(UploadSecurityUnavailableError);
  });

  it("rejects a sanitizer output larger than 8 MB", async () => {
    await expect(
      processUploadSecurity(TINY_PNG, "image/png", {
        env: rasterEnv,
        rasterSanitizer: async () =>
          Buffer.concat([TINY_JPEG, Buffer.alloc(MAX_UPLOAD_BYTES)]),
      }),
    ).rejects.toBeInstanceOf(UploadSecurityRejectedError);
  });

  it("self-tests embedded PNG and JPEG fixtures without database access", async () => {
    await expect(
      checkUploadSecurityReadiness({ env: rasterEnv }),
    ).resolves.toBeUndefined();
  });

  it("fails readiness closed when the sanitizer cannot process a fixture", async () => {
    await expect(
      checkUploadSecurityReadiness({
        env: rasterEnv,
        rasterSanitizer: async () => {
          throw new Error("synthetic sanitizer failure");
        },
      }),
    ).rejects.toBeInstanceOf(UploadSecurityUnavailableError);
  });
});

describe("local upload malware quarantine", () => {
  const temporaryDirectories: string[] = [];
  const bytes = Buffer.from("%PDF-1.7\nnon-sensitive test document", "utf8");

  async function createQuarantine(): Promise<string> {
    const directory = await mkdtemp(
      path.join(tmpdir(), "health-credential-quarantine-"),
    );
    temporaryDirectories.push(directory);
    return directory;
  }

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("persists nothing after a clean Defender verdict", async () => {
    const quarantineDir = await createQuarantine();
    let stagedPath = "";

    await scanUploadForMalware(bytes, {
      quarantineDir,
      timeoutMs: 5_000,
      scanner: async ({ filePath, timeoutMs }) => {
        stagedPath = filePath;
        expect(path.basename(filePath)).toMatch(
          /^upload-[0-9a-f-]{36}\.quarantine$/,
        );
        await expect(readFile(filePath)).resolves.toEqual(bytes);
        expect(timeoutMs).toBe(5_000);
        return "clean";
      },
    });

    expect(stagedPath).not.toBe("");
    await expect(readdir(quarantineDir)).resolves.toEqual([]);
  });

  it("rejects an infected verdict and deletes the staged file", async () => {
    const quarantineDir = await createQuarantine();

    await expect(
      scanUploadForMalware(bytes, {
        quarantineDir,
        timeoutMs: 5_000,
        scanner: async () => "infected",
      }),
    ).rejects.toBeInstanceOf(MalwareDetectedError);
    await expect(readdir(quarantineDir)).resolves.toEqual([]);
  });

  it("fails closed on scanner errors and deletes the staged file", async () => {
    const quarantineDir = await createQuarantine();

    await expect(
      scanUploadForMalware(bytes, {
        quarantineDir,
        timeoutMs: 5_000,
        scanner: async () => {
          throw new Error("synthetic scanner failure");
        },
      }),
    ).rejects.toBeInstanceOf(MalwareScanUnavailableError);
    await expect(readdir(quarantineDir)).resolves.toEqual([]);
  });

  it("fails closed without an explicitly configured production scanner", async () => {
    const quarantineDir = await createQuarantine();

    await expect(
      scanUploadForMalware(bytes, {
        quarantineDir,
        env: { NODE_ENV: "production" },
        platform: "win32",
      }),
    ).rejects.toBeInstanceOf(MalwareScanUnavailableError);
    await expect(readdir(quarantineDir)).resolves.toEqual([]);
  });

  it("verifies an explicitly configured Defender executable and quarantine", async () => {
    const quarantineDir = await createQuarantine();
    const executableDir = await createQuarantine();
    const executablePath = path.join(executableDir, "MpCmdRun.exe");
    await writeFile(executablePath, "readiness-test-placeholder", {
      flag: "wx",
    });

    await expect(
      checkMalwareScannerReadiness({
        env: {
          MALWARE_SCAN_PROVIDER: "windows-defender",
          MALWARE_QUARANTINE_DIR: quarantineDir,
          MALWARE_SCAN_TIMEOUT_MS: "5000",
          WINDOWS_DEFENDER_MPCMDRUN_PATH: executablePath,
        },
        platform: "win32",
      }),
    ).resolves.toBeUndefined();
    await expect(readdir(quarantineDir)).resolves.toEqual([]);
  });

  it("rejects a Windows-only scanner on a Linux production host", async () => {
    const quarantineDir = await createQuarantine();

    await expect(
      checkMalwareScannerReadiness({
        env: {
          NODE_ENV: "production",
          MALWARE_SCAN_PROVIDER: "windows-defender",
          MALWARE_QUARANTINE_DIR: quarantineDir,
          MALWARE_SCAN_TIMEOUT_MS: "5000",
          WINDOWS_DEFENDER_MPCMDRUN_PATH: "/opt/scanner/MpCmdRun.exe",
        },
        platform: "linux",
      }),
    ).rejects.toBeInstanceOf(MalwareScanUnavailableError);
  });

  it("fails closed on a prior remnant without deleting it", async () => {
    const quarantineDir = await createQuarantine();
    const remnantPath = path.join(quarantineDir, "prior-remnant");
    await writeFile(remnantPath, "operator inspection required", {
      flag: "wx",
    });
    const scanner = vi.fn(async () => "clean" as const);

    await expect(
      scanUploadForMalware(bytes, {
        quarantineDir,
        timeoutMs: 5_000,
        scanner,
      }),
    ).rejects.toBeInstanceOf(MalwareQuarantineRemnantError);

    expect(scanner).not.toHaveBeenCalled();
    await expect(readFile(remnantPath, "utf8")).resolves.toBe(
      "operator inspection required",
    );
  });

  it("rejects a concurrent scan instead of creating an unbounded queue", async () => {
    const quarantineDir = await createQuarantine();
    const executableDir = await createQuarantine();
    const executablePath = path.join(executableDir, "MpCmdRun.exe");
    await writeFile(executablePath, "readiness-test-placeholder", {
      flag: "wx",
    });
    let activeScans = 0;
    let maximumActiveScans = 0;
    let releaseFirstScan: () => void = () => {};
    let notifyFirstScan: () => void = () => {};
    const firstScanEntered = new Promise<void>((resolve) => {
      notifyFirstScan = resolve;
    });
    const firstScanRelease = new Promise<void>((resolve) => {
      releaseFirstScan = resolve;
    });
    const scanner = vi.fn(async () => {
      activeScans += 1;
      maximumActiveScans = Math.max(maximumActiveScans, activeScans);
      notifyFirstScan();
      await firstScanRelease;
      activeScans -= 1;
      return "clean" as const;
    });

    const first = scanUploadForMalware(bytes, {
      quarantineDir,
      timeoutMs: 5_000,
      scanner,
    });
    await firstScanEntered;
    await expect(
      scanUploadForMalware(bytes, {
        quarantineDir,
        timeoutMs: 5_000,
        scanner,
      }),
    ).rejects.toBeInstanceOf(MalwareScanBusyError);
    await expect(
      checkMalwareScannerReadiness({
        env: {
          MALWARE_SCAN_PROVIDER: "windows-defender",
          MALWARE_QUARANTINE_DIR: quarantineDir,
          MALWARE_SCAN_TIMEOUT_MS: "5000",
          WINDOWS_DEFENDER_MPCMDRUN_PATH: executablePath,
        },
        platform: "win32",
      }),
    ).resolves.toBeUndefined();

    expect(scanner).toHaveBeenCalledTimes(1);
    releaseFirstScan();
    await first;

    expect(scanner).toHaveBeenCalledTimes(1);
    expect(maximumActiveScans).toBe(1);
    await expect(readdir(quarantineDir)).resolves.toEqual([]);
  });

  it("leaves a cleanup failure latched by its remnant", async () => {
    const quarantineDir = await createQuarantine();

    await expect(
      scanUploadForMalware(bytes, {
        quarantineDir,
        timeoutMs: 5_000,
        scanner: async () => "clean",
        cleanup: async () => {
          throw new Error("synthetic cleanup failure");
        },
      }),
    ).rejects.toBeInstanceOf(MalwareQuarantineCleanupError);
    const entriesAfterFailure = await readdir(quarantineDir);
    expect(entriesAfterFailure).toHaveLength(1);

    const scanner = vi.fn(async () => "clean" as const);
    await expect(
      scanUploadForMalware(bytes, {
        quarantineDir,
        timeoutMs: 5_000,
        scanner,
      }),
    ).rejects.toBeInstanceOf(MalwareQuarantineRemnantError);

    expect(scanner).not.toHaveBeenCalled();
    await expect(readdir(quarantineDir)).resolves.toEqual(entriesAfterFailure);
  });

  it("rejects quarantine directories inside the source checkout", async () => {
    await expect(
      scanUploadForMalware(bytes, {
        quarantineDir: process.cwd(),
        timeoutMs: 5_000,
        scanner: async () => "clean",
      }),
    ).rejects.toBeInstanceOf(MalwareScanUnavailableError);
  });
});
