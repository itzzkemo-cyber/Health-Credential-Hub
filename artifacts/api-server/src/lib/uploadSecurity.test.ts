import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  uploadGrantsTable: {},
}));

import {
  CONTENT_SHA256_METADATA_KEY,
  hasAllowedUploadSignature,
  MalwareDetectedError,
  MalwareQuarantineCleanupError,
  MalwareQuarantineRemnantError,
  MalwareScanBusyError,
  MalwareScanUnavailableError,
  scanUploadForMalware,
  validateUploadedObject,
} from "./uploadSecurity";
import type { StoredObjectFile, StoredObjectMetadata } from "./objectStorage";

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

describe("credential upload content verification", () => {
  it.each([
    ["application/pdf", Buffer.from("%PDF-1.7\n")],
    [
      "image/png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
    ["image/gif", Buffer.from("GIF89a", "ascii")],
    [
      "image/webp",
      Buffer.concat([
        Buffer.from("RIFF", "ascii"),
        Buffer.alloc(4),
        Buffer.from("WEBP", "ascii"),
      ]),
    ],
    [
      "image/avif",
      Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif", "ascii")]),
    ],
    [
      "image/heic",
      Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic", "ascii")]),
    ],
  ])("accepts the real signature for %s", (contentType, bytes) => {
    expect(hasAllowedUploadSignature(bytes, contentType)).toBe(true);
  });

  it("rejects active content renamed as a PDF", () => {
    expect(
      hasAllowedUploadSignature(
        Buffer.from("<script>alert(1)</script>"),
        "application/pdf",
      ),
    ).toBe(false);
  });

  it("records a SHA-256 hash while preserving existing metadata", async () => {
    const bytes = Buffer.from("%PDF-1.7\nprivate credential");
    const file = storedFile(bytes, "application/pdf", { existing: "value" });

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
    const bytes = Buffer.from("%PDF-1.7\nchanged credential");
    const file = storedFile(bytes, "application/pdf", {
      [CONTENT_SHA256_METADATA_KEY]: "0".repeat(64),
    });

    await expect(validateUploadedObject(file)).rejects.toThrow(
      /integrity hash mismatch/,
    );
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
