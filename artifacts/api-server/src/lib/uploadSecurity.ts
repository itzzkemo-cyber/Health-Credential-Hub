import type { StoredObjectFile } from "./objectStorage";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, uploadGrantsTable, type UploadGrant } from "@workspace/db";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const ALLOWED_UPLOAD_CONTENT_TYPE =
  /^(image\/(png|jpe?g|webp|gif|avif|heic|heif)|application\/pdf)$/i;
export const UPLOAD_GRANT_TTL_MS = 15 * 60 * 1000;
export const CONTENT_SHA256_METADATA_KEY = "content-sha256";
export const DEFAULT_MALWARE_SCAN_TIMEOUT_MS = 60_000;
export const MAX_CONCURRENT_MALWARE_SCANS = 1;

const MIN_MALWARE_SCAN_TIMEOUT_MS = 5_000;
const MAX_MALWARE_SCAN_TIMEOUT_MS = 120_000;
const MAX_SCANNER_OUTPUT_BYTES = 64 * 1024;
const WINDOWS_DEFENDER_PROVIDER = "windows-defender";

export type MalwareScanVerdict = "clean" | "infected";

export interface MalwareScanRequest {
  filePath: string;
  timeoutMs: number;
}

export type MalwareScanRunner = (
  request: MalwareScanRequest,
) => Promise<MalwareScanVerdict>;

export interface ScanUploadForMalwareOptions {
  /** Explicit injection point for non-production tests. */
  scanner?: MalwareScanRunner;
  /** Explicit injection point for non-production tests. */
  quarantineDir?: string;
  /** Explicit injection point for cleanup-failure tests. */
  cleanup?: (filePath: string) => Promise<void>;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface MalwareScannerReadinessOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export class MalwareDetectedError extends Error {
  constructor() {
    super("The uploaded file failed malware screening");
    this.name = "MalwareDetectedError";
  }
}

export class MalwareScanUnavailableError extends Error {
  constructor() {
    super("Malware screening is unavailable");
    this.name = "MalwareScanUnavailableError";
  }
}

export class MalwareQuarantineCleanupError extends Error {
  constructor() {
    super("Malware quarantine cleanup failed");
    this.name = "MalwareQuarantineCleanupError";
  }
}

export class MalwareQuarantineRemnantError extends MalwareScanUnavailableError {
  constructor() {
    super();
    this.name = "MalwareQuarantineRemnantError";
  }
}

export class MalwareScanBusyError extends MalwareScanUnavailableError {
  constructor() {
    super();
    this.name = "MalwareScanBusyError";
  }
}

// The filesystem deployment is a single API process. Defender and the shared
// quarantine directory support one active scan. Reject concurrent work instead
// of retaining upload buffers in an unbounded Promise chain.
let activeMalwareScans = 0;

async function withMalwareScanSlot<T>(action: () => Promise<T>): Promise<T> {
  if (activeMalwareScans >= MAX_CONCURRENT_MALWARE_SCANS) {
    throw new MalwareScanBusyError();
  }
  activeMalwareScans += 1;
  try {
    return await action();
  } finally {
    activeMalwareScans -= 1;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function readMalwareScanTimeout(
  raw: string | undefined,
  override?: number,
): number {
  const timeout =
    override ?? (raw ? Number(raw) : DEFAULT_MALWARE_SCAN_TIMEOUT_MS);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_MALWARE_SCAN_TIMEOUT_MS ||
    timeout > MAX_MALWARE_SCAN_TIMEOUT_MS
  ) {
    throw new MalwareScanUnavailableError();
  }
  return timeout;
}

async function findSourceCheckoutRoot(
  startDirectory: string,
): Promise<string | null> {
  let candidate = startDirectory;
  while (true) {
    try {
      await stat(path.join(candidate, ".git"));
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new MalwareScanUnavailableError();
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function prepareQuarantineDirectory(
  configuredPath: string,
): Promise<string> {
  if (!configuredPath || !path.isAbsolute(configuredPath)) {
    throw new MalwareScanUnavailableError();
  }
  try {
    await mkdir(configuredPath, { recursive: true, mode: 0o700 });
    const [directory, workspace] = await Promise.all([
      realpath(configuredPath),
      realpath(process.cwd()),
    ]);
    const checkoutRoot = await findSourceCheckoutRoot(workspace);
    const directoryStats = await stat(directory);
    if (
      !directoryStats.isDirectory() ||
      isPathInside(checkoutRoot ?? workspace, directory)
    ) {
      throw new MalwareScanUnavailableError();
    }
    return directory;
  } catch (error) {
    if (error instanceof MalwareScanUnavailableError) throw error;
    throw new MalwareScanUnavailableError();
  }
}

function scannerOutputIndicatesThreat(output: Buffer): boolean {
  // Defender's human-readable output is used only to distinguish a detected
  // threat from a scanner failure. Unknown/localized non-zero results remain
  // fail-closed as unavailable; output is never logged or returned.
  const text = output.toString("utf8");
  return (
    /(?:detected|found)\s+[1-9][0-9]*\s+threats?/i.test(text) ||
    /threats?\s+(?:was|were|has been|have been)?\s*(?:detected|found)/i.test(
      text,
    )
  );
}

async function validateWindowsDefenderExecutable(
  executablePath: string,
): Promise<void> {
  if (
    !path.isAbsolute(executablePath) ||
    path.basename(executablePath).toLowerCase() !== "mpcmdrun.exe"
  ) {
    throw new MalwareScanUnavailableError();
  }
  try {
    const executableStats = await stat(executablePath);
    if (!executableStats.isFile()) throw new MalwareScanUnavailableError();
  } catch (error) {
    if (error instanceof MalwareScanUnavailableError) throw error;
    throw new MalwareScanUnavailableError();
  }
}

async function runWindowsDefenderScan(
  executablePath: string,
  request: MalwareScanRequest,
): Promise<MalwareScanVerdict> {
  await validateWindowsDefenderExecutable(executablePath);

  return new Promise<MalwareScanVerdict>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let outputSize = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let forceFinishTimer: NodeJS.Timeout | undefined;

    const child = spawn(
      executablePath,
      [
        "-Scan",
        "-ScanType",
        "3",
        "-File",
        request.filePath,
        "-DisableRemediation",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const finish = (
      error: MalwareScanUnavailableError | null,
      verdict?: MalwareScanVerdict,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      if (error) reject(error);
      else resolve(verdict ?? "clean");
    };

    const collectOutput = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputSize += bytes.length;
      if (outputSize > MAX_SCANNER_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      chunks.push(bytes);
    };

    child.stdout.on("data", collectOutput);
    child.stderr.on("data", collectOutput);
    child.once("error", () => finish(new MalwareScanUnavailableError()));
    child.once("close", (code) => {
      if (timedOut || outputExceeded) {
        finish(new MalwareScanUnavailableError());
        return;
      }
      const output = Buffer.concat(chunks, outputSize);
      if (scannerOutputIndicatesThreat(output)) {
        finish(null, "infected");
        return;
      }
      if (code === 0) {
        finish(null, "clean");
        return;
      }
      finish(new MalwareScanUnavailableError());
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Do not let a stuck external process hold an HTTP request forever.
      forceFinishTimer = setTimeout(
        () => finish(new MalwareScanUnavailableError()),
        2_000,
      );
      forceFinishTimer.unref();
    }, request.timeoutMs);
    timeoutTimer.unref();
  });
}

async function getConfiguredMalwareScanner(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<MalwareScanRunner> {
  if (
    env.MALWARE_SCAN_PROVIDER !== WINDOWS_DEFENDER_PROVIDER ||
    platform !== "win32" ||
    !env.WINDOWS_DEFENDER_MPCMDRUN_PATH
  ) {
    throw new MalwareScanUnavailableError();
  }
  const executablePath = env.WINDOWS_DEFENDER_MPCMDRUN_PATH;
  return (request) => runWindowsDefenderScan(executablePath, request);
}

/**
 * Verify that the fail-closed server-mediated upload path has a supported
 * scanner executable and a clean, isolated quarantine directory. This probe
 * intentionally does not expose the executable path or scanner output.
 */
export async function checkMalwareScannerReadiness(
  options: MalwareScannerReadinessOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  readMalwareScanTimeout(env.MALWARE_SCAN_TIMEOUT_MS);
  await getConfiguredMalwareScanner(env, platform);
  await validateWindowsDefenderExecutable(
    env.WINDOWS_DEFENDER_MPCMDRUN_PATH ?? "",
  );
  try {
    await withMalwareScanSlot(async () => {
      const quarantineDir = await prepareQuarantineDirectory(
        env.MALWARE_QUARANTINE_DIR ?? "",
      );
      await assertQuarantineHasNoRemnants(quarantineDir);
    });
  } catch (error) {
    // An in-flight upload already owns the same bounded slot and proves the
    // scanner path is actively in use. Do not make orchestration restart the
    // service in the middle of that upload; the next idle probe checks cleanup.
    if (error instanceof MalwareScanBusyError) return;
    throw error;
  }
}

async function removeQuarantinedFile(filePath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(filePath, { force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  void lastError;
  throw new MalwareQuarantineCleanupError();
}

async function assertQuarantineHasNoRemnants(
  quarantineDir: string,
): Promise<void> {
  try {
    const entries = await readdir(quarantineDir);
    if (entries.length > 0) throw new MalwareQuarantineRemnantError();
  } catch (error) {
    if (error instanceof MalwareQuarantineRemnantError) throw error;
    throw new MalwareScanUnavailableError();
  }
}

/**
 * Stage an upload under a random, non-identifying name outside the checkout,
 * scan it locally, then remove the staged file before the caller can persist
 * the original bytes. No browser filename, employee identifier, object path,
 * scanner output, or file content is logged or returned.
 */
export async function scanUploadForMalware(
  bytes: Buffer,
  options: ScanUploadForMalwareOptions = {},
): Promise<void> {
  if (bytes.length <= 0 || bytes.length > MAX_UPLOAD_BYTES) {
    throw new MalwareScanUnavailableError();
  }

  return withMalwareScanSlot(async () => {
    const env = options.env ?? process.env;
    const timeoutMs = readMalwareScanTimeout(
      env.MALWARE_SCAN_TIMEOUT_MS,
      options.timeoutMs,
    );
    const quarantineDir = await prepareQuarantineDirectory(
      options.quarantineDir ?? env.MALWARE_QUARANTINE_DIR ?? "",
    );
    // Never guess whether an existing entry is safe to remove. An entry here
    // means an earlier scan did not complete its cleanup or the directory is
    // being used incorrectly; an operator must investigate it.
    await assertQuarantineHasNoRemnants(quarantineDir);
    const scanner =
      options.scanner ??
      (await getConfiguredMalwareScanner(
        env,
        options.platform ?? process.platform,
      ));
    const quarantinePath = path.join(
      quarantineDir,
      `upload-${randomUUID()}.quarantine`,
    );

    let scanError: unknown;
    try {
      await writeFile(quarantinePath, bytes, { flag: "wx", mode: 0o600 });
      const verdict = await scanner({ filePath: quarantinePath, timeoutMs });
      if (verdict === "infected") throw new MalwareDetectedError();
      if (verdict !== "clean") throw new MalwareScanUnavailableError();
    } catch (error) {
      scanError =
        error instanceof MalwareDetectedError ||
        error instanceof MalwareScanUnavailableError
          ? error
          : new MalwareScanUnavailableError();
    }

    try {
      await (options.cleanup ?? removeQuarantinedFile)(quarantinePath);
    } catch {
      throw new MalwareQuarantineCleanupError();
    }
    if (scanError) throw scanError;
  });
}

function startsWith(bytes: Buffer, signature: number[] | string): boolean {
  const expected =
    typeof signature === "string"
      ? Buffer.from(signature, "ascii")
      : Buffer.from(signature);
  return (
    bytes.length >= expected.length &&
    bytes.subarray(0, expected.length).equals(expected)
  );
}

/**
 * Reject active content renamed to an allowed MIME type. This is deliberately
 * a small deterministic signature allowlist, not a malware scanner.
 */
export function hasAllowedUploadSignature(
  bytes: Buffer,
  contentType: string,
): boolean {
  const normalized = contentType.toLowerCase();
  if (normalized === "application/pdf") return startsWith(bytes, "%PDF-");
  if (normalized === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return startsWith(bytes, [0xff, 0xd8, 0xff]);
  }
  if (normalized === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (normalized === "image/gif") {
    const header = bytes.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  if (
    normalized === "image/avif" ||
    normalized === "image/heic" ||
    normalized === "image/heif"
  ) {
    if (
      bytes.length < 12 ||
      bytes.subarray(4, 8).toString("ascii") !== "ftyp"
    ) {
      return false;
    }
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (normalized === "image/avif") return ["avif", "avis"].includes(brand);
    return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand);
  }
  return false;
}

export async function findActiveUploadGrant(
  objectPath: string,
  requestedBy: number,
): Promise<UploadGrant | null> {
  const rows = await db
    .select()
    .from(uploadGrantsTable)
    .where(
      and(
        eq(uploadGrantsTable.objectPath, objectPath),
        eq(uploadGrantsTable.requestedBy, requestedBy),
        isNull(uploadGrantsTable.claimedAt),
        gt(uploadGrantsTable.expiresAt, new Date()),
      ),
    );
  return rows[0] ?? null;
}

/**
 * Verify server-observed object metadata, never just the values declared by
 * the browser before upload. Exact matching also ensures a presigned URL is
 * used for the file that was approved, not a substituted larger payload.
 */
export async function validateUploadedObject(
  objectFile: StoredObjectFile,
  grant?: UploadGrant | null,
): Promise<{
  contentType: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}> {
  const [metadata] = await objectFile.getMetadata();
  const contentType = String(metadata.contentType ?? "").toLowerCase();
  const size = Number(metadata.size ?? 0);

  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_UPLOAD_BYTES ||
    !ALLOWED_UPLOAD_CONTENT_TYPE.test(contentType)
  ) {
    throw new Error("Stored object violates the upload policy");
  }
  if (
    grant &&
    (size !== grant.declaredSize ||
      contentType !== grant.declaredContentType.toLowerCase())
  ) {
    throw new Error("Stored object metadata does not match its upload grant");
  }
  const [bytes] = await objectFile.download();
  if (bytes.length !== size || !hasAllowedUploadSignature(bytes, contentType)) {
    throw new Error("Stored object content does not match its upload policy");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const recordedHash = metadata.metadata?.[CONTENT_SHA256_METADATA_KEY];
  if (recordedHash && recordedHash !== sha256) {
    throw new Error("Stored object integrity hash mismatch");
  }
  if (!recordedHash) {
    await objectFile.setMetadata({
      metadata: {
        ...(metadata.metadata ?? {}),
        [CONTENT_SHA256_METADATA_KEY]: sha256,
      },
    });
  }
  return { contentType, size, sha256, bytes };
}

export async function consumeUploadGrant(grantId: number): Promise<boolean> {
  const rows = await db
    .update(uploadGrantsTable)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(uploadGrantsTable.id, grantId),
        isNull(uploadGrantsTable.claimedAt),
        gt(uploadGrantsTable.expiresAt, new Date()),
      ),
    )
    .returning({ id: uploadGrantsTable.id });
  return rows.length === 1;
}
