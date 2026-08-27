import type { StoredObjectFile } from "./objectStorage";
import type { UploadGrant } from "@workspace/db";
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
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
// sharp 0.35.0 ships lib/index.d.ts but its export map omits a `types`
// condition. Keep the required runtime pinned while locally constraining the
// small API surface used below until the upstream export map is corrected.
// @ts-expect-error sharp 0.35.0 export map does not expose bundled declarations
import sharp from "sharp";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const ALLOWED_UPLOAD_CONTENT_TYPE = /^(?:image\/jpeg|image\/png)$/i;
export const UPLOAD_GRANT_TTL_MS = 15 * 60 * 1000;
export const CONTENT_SHA256_METADATA_KEY = "content-sha256";
export const DEFAULT_MALWARE_SCAN_TIMEOUT_MS = 60_000;
export const MAX_CONCURRENT_MALWARE_SCANS = 1;
export const RASTER_SANITIZER_TIMEOUT_MS = 15_000;
export const RASTER_SANITIZER_MAX_INPUT_PIXELS = 12_000_000;
export const RASTER_SANITIZER_MAX_INPUT_CHANNELS = 4;
export const RASTER_SANITIZER_MAX_EDGE = 4_000;

const MIN_MALWARE_SCAN_TIMEOUT_MS = 5_000;
const MAX_MALWARE_SCAN_TIMEOUT_MS = 120_000;
const MAX_SCANNER_OUTPUT_BYTES = 64 * 1024;
const WINDOWS_DEFENDER_PROVIDER = "windows-defender";
const RASTER_SANITIZER_PROVIDER = "raster-sanitizer";
const SANITIZED_CONTENT_TYPE = "image/jpeg" as const;
const PROCESSING_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RasterMetadata {
  format?: string;
  width?: number;
  height?: number;
  channels?: number;
  pages?: number;
  pageHeight?: number;
}

interface RasterOutputInfo {
  format: string;
  width: number;
  height: number;
}

// Keep native image processing bounded for a small API instance. The request
// path has an additional single-upload slot, so libvips never needs an
// unbounded cache or worker pool for sensitive document images.
sharp.cache({ memory: 16, files: 0, items: 4 });
sharp.concurrency(1);

const RASTER_SELF_TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  "base64",
);
const RASTER_SELF_TEST_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
  "base64",
);

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

export interface ProcessedUpload {
  bytes: Buffer;
  contentType: typeof SANITIZED_CONTENT_TYPE | "image/png";
  sha256: string;
}

export type RasterSanitizerRunner = (
  bytes: Buffer,
  contentType: "image/jpeg" | "image/png",
) => Promise<Buffer>;

export interface ProcessUploadSecurityOptions extends ScanUploadForMalwareOptions {
  /** Explicit injection point for bounded failure-path tests. */
  rasterSanitizer?: RasterSanitizerRunner;
  /** Production always uses 15 seconds; tests may shorten the deadline. */
  sanitizerTimeoutMs?: number;
}

export interface UploadSecurityReadinessOptions extends MalwareScannerReadinessOptions {
  /** Explicit injection point for readiness failure tests. */
  rasterSanitizer?: RasterSanitizerRunner;
}

export class UploadSecurityRejectedError extends Error {
  constructor() {
    super("The uploaded image failed security processing");
    this.name = "UploadSecurityRejectedError";
  }
}

export class UploadSecurityUnavailableError extends Error {
  constructor() {
    super("Upload security processing is unavailable");
    this.name = "UploadSecurityUnavailableError";
  }
}

export class UploadSecurityBusyError extends UploadSecurityUnavailableError {
  constructor() {
    super();
    this.name = "UploadSecurityBusyError";
  }
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

// The server-mediated deployment is a single API process. Native raster work
// and the legacy quarantine scanner share one bounded slot. Reject concurrent
// work instead of retaining sensitive upload buffers in a Promise queue.
let activeUploadSecurityJobs = 0;

async function withUploadSecuritySlot<T>(
  action: () => Promise<T>,
  busyError: () => Error = () => new UploadSecurityBusyError(),
): Promise<T> {
  if (activeUploadSecurityJobs >= MAX_CONCURRENT_MALWARE_SCANS) {
    throw busyError();
  }
  activeUploadSecurityJobs += 1;
  try {
    return await action();
  } finally {
    activeUploadSecurityJobs -= 1;
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
  const configuredProvider =
    env.UPLOAD_SECURITY_PROVIDER?.trim().toLowerCase() ||
    env.MALWARE_SCAN_PROVIDER?.trim().toLowerCase();
  if (
    configuredProvider !== WINDOWS_DEFENDER_PROVIDER ||
    platform !== "win32" ||
    !env.WINDOWS_DEFENDER_MPCMDRUN_PATH
  ) {
    throw new MalwareScanUnavailableError();
  }
  const executablePath = env.WINDOWS_DEFENDER_MPCMDRUN_PATH;
  return (request) => runWindowsDefenderScan(executablePath, request);
}

function getConfiguredUploadSecurityProvider(
  env: NodeJS.ProcessEnv,
): typeof RASTER_SANITIZER_PROVIDER | typeof WINDOWS_DEFENDER_PROVIDER {
  const configured = env.UPLOAD_SECURITY_PROVIDER?.trim().toLowerCase();
  if (configured === RASTER_SANITIZER_PROVIDER) {
    return RASTER_SANITIZER_PROVIDER;
  }
  if (
    configured === WINDOWS_DEFENDER_PROVIDER ||
    (!configured &&
      env.MALWARE_SCAN_PROVIDER?.trim().toLowerCase() ===
        WINDOWS_DEFENDER_PROVIDER)
  ) {
    return WINDOWS_DEFENDER_PROVIDER;
  }
  throw new UploadSecurityUnavailableError();
}

function withSanitizerDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  cancel?: () => void,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new UploadSecurityUnavailableError();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        cancel?.();
      } catch {
        // Cancellation is best-effort; the security decision still fails shut.
      }
      reject(new UploadSecurityUnavailableError());
    }, timeoutMs);

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function remainingSanitizerTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new UploadSecurityUnavailableError();
  return remaining;
}

function sharpInputOptions() {
  return {
    animated: true,
    failOn: "warning",
    limitInputPixels: RASTER_SANITIZER_MAX_INPUT_PIXELS,
    limitInputChannels: RASTER_SANITIZER_MAX_INPUT_CHANNELS,
    sequentialRead: true,
  };
}

async function sanitizeRasterBytes(
  bytes: Buffer,
  declaredContentType: "image/jpeg" | "image/png",
): Promise<Buffer> {
  const deadline = Date.now() + RASTER_SANITIZER_TIMEOUT_MS;
  let metadata: RasterMetadata;
  try {
    const metadataPipeline = sharp(bytes, sharpInputOptions()).timeout({
      seconds: RASTER_SANITIZER_TIMEOUT_MS / 1_000,
    });
    metadata = await withSanitizerDeadline(
      metadataPipeline.metadata() as Promise<RasterMetadata>,
      remainingSanitizerTime(deadline),
      () => metadataPipeline.destroy(),
    );
  } catch (error) {
    if (error instanceof UploadSecurityUnavailableError) throw error;
    throw new UploadSecurityRejectedError();
  }

  const expectedFormat = declaredContentType === "image/jpeg" ? "jpeg" : "png";
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const channels = metadata.channels ?? 0;
  const pages = metadata.pages ?? 1;
  const pageHeight = metadata.pageHeight ?? height;
  if (
    metadata.format !== expectedFormat ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width * height > RASTER_SANITIZER_MAX_INPUT_PIXELS ||
    channels <= 0 ||
    channels > RASTER_SANITIZER_MAX_INPUT_CHANNELS ||
    pages !== 1 ||
    pageHeight !== height
  ) {
    throw new UploadSecurityRejectedError();
  }

  try {
    const remaining = remainingSanitizerTime(deadline);
    const rasterPipeline = sharp(bytes, sharpInputOptions())
      .timeout({
        seconds: Math.max(1, Math.ceil(remaining / 1_000)),
      })
      .rotate()
      .resize({
        width: RASTER_SANITIZER_MAX_EDGE,
        height: RASTER_SANITIZER_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({
        quality: 88,
        progressive: false,
        chromaSubsampling: "4:4:4",
        optimizeCoding: true,
      });
    const { data, info } = await withSanitizerDeadline(
      rasterPipeline.toBuffer({ resolveWithObject: true }) as Promise<{
        data: Buffer;
        info: RasterOutputInfo;
      }>,
      remaining,
      () => rasterPipeline.destroy(),
    );
    if (
      info.format !== "jpeg" ||
      info.width <= 0 ||
      info.height <= 0 ||
      info.width > RASTER_SANITIZER_MAX_EDGE ||
      info.height > RASTER_SANITIZER_MAX_EDGE
    ) {
      throw new UploadSecurityRejectedError();
    }
    return data;
  } catch (error) {
    if (
      error instanceof UploadSecurityRejectedError ||
      error instanceof UploadSecurityUnavailableError
    ) {
      throw error;
    }
    throw new UploadSecurityRejectedError();
  }
}

async function processRasterUploadWithoutSlot(
  bytes: Buffer,
  contentType: "image/jpeg" | "image/png",
  runner: RasterSanitizerRunner,
  timeoutMs: number,
): Promise<ProcessedUpload> {
  let processedBytes: Buffer;
  try {
    const operation = runner(bytes, contentType);
    processedBytes =
      runner === sanitizeRasterBytes
        ? await operation
        : await withSanitizerDeadline(operation, timeoutMs);
  } catch (error) {
    if (
      error instanceof UploadSecurityRejectedError ||
      error instanceof UploadSecurityUnavailableError
    ) {
      throw error;
    }
    throw new UploadSecurityRejectedError();
  }

  if (
    !Buffer.isBuffer(processedBytes) ||
    processedBytes.length <= 0 ||
    processedBytes.length > MAX_UPLOAD_BYTES ||
    !hasAllowedUploadSignature(processedBytes, SANITIZED_CONTENT_TYPE)
  ) {
    throw new UploadSecurityRejectedError();
  }
  return {
    bytes: processedBytes,
    contentType: SANITIZED_CONTENT_TYPE,
    sha256: createHash("sha256").update(processedBytes).digest("hex"),
  };
}

/**
 * Apply the configured fail-closed upload control. The raster provider parses
 * and re-encodes supported images before persistence; the Windows Defender
 * provider remains available only for existing single-host deployments.
 */
export async function processUploadSecurity(
  bytes: Buffer,
  contentType: string,
  options: ProcessUploadSecurityOptions = {},
): Promise<ProcessedUpload> {
  const normalizedContentType = contentType.trim().toLowerCase();
  if (
    bytes.length <= 0 ||
    bytes.length > MAX_UPLOAD_BYTES ||
    !ALLOWED_UPLOAD_CONTENT_TYPE.test(normalizedContentType) ||
    !hasAllowedUploadSignature(bytes, normalizedContentType) ||
    (normalizedContentType === "image/png" &&
      pngContainsAnimationControl(bytes))
  ) {
    throw new UploadSecurityRejectedError();
  }
  const typedContentType = normalizedContentType as "image/jpeg" | "image/png";
  const env = options.env ?? process.env;
  const provider = getConfiguredUploadSecurityProvider(env);

  if (provider === RASTER_SANITIZER_PROVIDER) {
    return withUploadSecuritySlot(() =>
      processRasterUploadWithoutSlot(
        bytes,
        typedContentType,
        options.rasterSanitizer ?? sanitizeRasterBytes,
        options.sanitizerTimeoutMs ?? RASTER_SANITIZER_TIMEOUT_MS,
      ),
    );
  }

  await scanUploadForMalware(bytes, options);
  return {
    bytes: Buffer.from(bytes),
    contentType: typedContentType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Verify that the configured fail-closed upload control can process both
 * accepted raster formats. The built-in fixtures contain no user data and the
 * probe performs no database or object-storage access.
 */
export async function checkUploadSecurityReadiness(
  options: UploadSecurityReadinessOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const provider = getConfiguredUploadSecurityProvider(env);

  if (provider === RASTER_SANITIZER_PROVIDER) {
    try {
      await withUploadSecuritySlot(async () => {
        const runner = options.rasterSanitizer ?? sanitizeRasterBytes;
        await processRasterUploadWithoutSlot(
          RASTER_SELF_TEST_PNG,
          "image/png",
          runner,
          RASTER_SANITIZER_TIMEOUT_MS,
        );
        await processRasterUploadWithoutSlot(
          RASTER_SELF_TEST_JPEG,
          "image/jpeg",
          runner,
          RASTER_SANITIZER_TIMEOUT_MS,
        );
      });
      return;
    } catch (error) {
      // An in-flight upload already proves the bounded native worker is live.
      if (error instanceof UploadSecurityBusyError) return;
      throw new UploadSecurityUnavailableError();
    }
  }

  readMalwareScanTimeout(env.MALWARE_SCAN_TIMEOUT_MS);
  await getConfiguredMalwareScanner(env, platform);
  await validateWindowsDefenderExecutable(
    env.WINDOWS_DEFENDER_MPCMDRUN_PATH ?? "",
  );
  try {
    await withUploadSecuritySlot(
      async () => {
        const quarantineDir = await prepareQuarantineDirectory(
          env.MALWARE_QUARANTINE_DIR ?? "",
        );
        await assertQuarantineHasNoRemnants(quarantineDir);
      },
      () => new MalwareScanBusyError(),
    );
  } catch (error) {
    // An in-flight upload already owns the same bounded slot and proves the
    // scanner path is actively in use. Do not make orchestration restart the
    // service in the middle of that upload; the next idle probe checks cleanup.
    if (error instanceof MalwareScanBusyError) return;
    throw error;
  }
}

/** @deprecated Use checkUploadSecurityReadiness. */
export const checkMalwareScannerReadiness = checkUploadSecurityReadiness;

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

  return withUploadSecuritySlot(
    async () => {
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
    },
    () => new MalwareScanBusyError(),
  );
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

function pngContainsAnimationControl(bytes: Buffer): boolean {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return false;
  }
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const nextOffset = offset + 12 + length;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.length) {
      return false;
    }
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "acTL") return true;
    if (type === "IEND") return false;
    offset = nextOffset;
  }
  return false;
}

/**
 * Cheaply reject a renamed payload before invoking the bounded raster parser.
 * Successful signature matching is only a prefilter; the sanitizer still
 * performs the authoritative decode and fresh JPEG encode.
 */
export function hasAllowedUploadSignature(
  bytes: Buffer,
  contentType: string,
): boolean {
  const normalized = contentType.toLowerCase();
  if (normalized === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (normalized === "image/jpeg") {
    return startsWith(bytes, [0xff, 0xd8, 0xff]);
  }
  return false;
}

export async function findActiveUploadGrant(
  objectPath: string,
  requestedBy: number,
): Promise<UploadGrant | null> {
  const { db, uploadGrantsTable } = await import("@workspace/db");
  const rows = await db
    .select()
    .from(uploadGrantsTable)
    .where(
      and(
        eq(uploadGrantsTable.objectPath, objectPath),
        eq(uploadGrantsTable.requestedBy, requestedBy),
        eq(uploadGrantsTable.status, "processed"),
        isNotNull(uploadGrantsTable.processedAt),
        isNotNull(uploadGrantsTable.processedSha256),
        isNull(uploadGrantsTable.claimedAt),
        gt(uploadGrantsTable.expiresAt, new Date()),
      ),
    );
  return rows[0] ?? null;
}

/**
 * Atomically reserve the original browser declaration before native parsing.
 * A second API instance cannot process or link this grant while its opaque
 * per-attempt token owns the `processing` state.
 */
export async function reserveUploadGrantForProcessing(
  objectPath: string,
  requestedBy: number,
  originalSize: number,
  originalContentType: "image/jpeg" | "image/png",
  processingToken: string,
): Promise<UploadGrant | null> {
  if (
    !/^\/objects\/uploads\/[0-9a-f-]{36}$/.test(objectPath) ||
    !Number.isSafeInteger(requestedBy) ||
    requestedBy <= 0 ||
    !Number.isSafeInteger(originalSize) ||
    originalSize <= 0 ||
    originalSize > MAX_UPLOAD_BYTES ||
    !ALLOWED_UPLOAD_CONTENT_TYPE.test(originalContentType) ||
    !PROCESSING_TOKEN_PATTERN.test(processingToken)
  ) {
    return null;
  }
  const { db, uploadGrantsTable } = await import("@workspace/db");
  const rows = await db
    .update(uploadGrantsTable)
    .set({
      status: "processing",
      processingToken,
      processingStartedAt: new Date(),
      processedAt: null,
      processedSha256: null,
    })
    .where(
      and(
        eq(uploadGrantsTable.objectPath, objectPath),
        eq(uploadGrantsTable.requestedBy, requestedBy),
        eq(uploadGrantsTable.declaredSize, originalSize),
        eq(uploadGrantsTable.declaredContentType, originalContentType),
        eq(uploadGrantsTable.status, "pending"),
        isNull(uploadGrantsTable.processingToken),
        isNull(uploadGrantsTable.claimedAt),
        gt(uploadGrantsTable.expiresAt, new Date()),
      ),
    )
    .returning();
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
  if (
    grant &&
    (grant.status !== "processed" ||
      !grant.processedAt ||
      !grant.processedSha256 ||
      !/^[a-f0-9]{64}$/.test(grant.processedSha256))
  ) {
    throw new Error("Upload grant has not completed security processing");
  }
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
  if (grant && grant.processedSha256 !== sha256) {
    throw new Error("Stored object does not match its processed upload grant");
  }
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

/**
 * Finalize the server-observed metadata and hash only while the same processing
 * attempt still owns the unclaimed, unexpired grant.
 */
export async function finalizeUploadGrantProcessing(
  grantId: number,
  requestedBy: number,
  objectPath: string,
  processingToken: string,
  declaredSize: number,
  declaredContentType: "image/jpeg" | "image/png",
  processedSha256: string,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(grantId) ||
    grantId <= 0 ||
    !Number.isSafeInteger(requestedBy) ||
    requestedBy <= 0 ||
    !PROCESSING_TOKEN_PATTERN.test(processingToken) ||
    !Number.isSafeInteger(declaredSize) ||
    declaredSize <= 0 ||
    declaredSize > MAX_UPLOAD_BYTES ||
    !ALLOWED_UPLOAD_CONTENT_TYPE.test(declaredContentType) ||
    !/^[a-f0-9]{64}$/.test(processedSha256)
  ) {
    return false;
  }
  const { db, uploadGrantsTable } = await import("@workspace/db");
  const rows = await db
    .update(uploadGrantsTable)
    .set({
      declaredSize,
      declaredContentType,
      status: "processed",
      processingToken: null,
      processedAt: new Date(),
      processedSha256,
    })
    .where(
      and(
        eq(uploadGrantsTable.id, grantId),
        eq(uploadGrantsTable.requestedBy, requestedBy),
        eq(uploadGrantsTable.objectPath, objectPath),
        eq(uploadGrantsTable.status, "processing"),
        eq(uploadGrantsTable.processingToken, processingToken),
        isNotNull(uploadGrantsTable.processingStartedAt),
        isNull(uploadGrantsTable.claimedAt),
        gt(uploadGrantsTable.expiresAt, new Date()),
      ),
    )
    .returning({ id: uploadGrantsTable.id });
  return rows.length === 1;
}

/**
 * Rotate the attempt token before deleting a failed durable object. If a
 * possibly-ambiguous finalization already committed, this CAS fails and the
 * caller must not delete an object that credentials could now claim.
 */
export async function reserveUploadGrantFailureCleanup(
  grantId: number,
  requestedBy: number,
  objectPath: string,
  processingToken: string,
  cleanupToken: string,
): Promise<boolean> {
  if (
    !PROCESSING_TOKEN_PATTERN.test(processingToken) ||
    !PROCESSING_TOKEN_PATTERN.test(cleanupToken)
  ) {
    return false;
  }
  const { db, uploadGrantsTable } = await import("@workspace/db");
  const rows = await db
    .update(uploadGrantsTable)
    .set({ processingToken: cleanupToken })
    .where(
      and(
        eq(uploadGrantsTable.id, grantId),
        eq(uploadGrantsTable.requestedBy, requestedBy),
        eq(uploadGrantsTable.objectPath, objectPath),
        eq(uploadGrantsTable.status, "processing"),
        eq(uploadGrantsTable.processingToken, processingToken),
        isNull(uploadGrantsTable.claimedAt),
      ),
    )
    .returning({ id: uploadGrantsTable.id });
  return rows.length === 1;
}

/** Reset an owned processing attempt only after no durable object remains. */
export async function rollbackUploadGrantProcessing(
  grantId: number,
  requestedBy: number,
  objectPath: string,
  processingToken: string,
): Promise<boolean> {
  if (!PROCESSING_TOKEN_PATTERN.test(processingToken)) return false;
  const { db, uploadGrantsTable } = await import("@workspace/db");
  const rows = await db
    .update(uploadGrantsTable)
    .set({
      status: "pending",
      processingToken: null,
      processingStartedAt: null,
      processedAt: null,
      processedSha256: null,
    })
    .where(
      and(
        eq(uploadGrantsTable.id, grantId),
        eq(uploadGrantsTable.requestedBy, requestedBy),
        eq(uploadGrantsTable.objectPath, objectPath),
        eq(uploadGrantsTable.status, "processing"),
        eq(uploadGrantsTable.processingToken, processingToken),
        isNull(uploadGrantsTable.claimedAt),
      ),
    )
    .returning({ id: uploadGrantsTable.id });
  return rows.length === 1;
}

export async function consumeUploadGrant(
  grantId: number,
  requestedBy: number,
  objectPath: string,
  processedSha256: string,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(grantId) ||
    grantId <= 0 ||
    !Number.isSafeInteger(requestedBy) ||
    requestedBy <= 0 ||
    !/^\/objects\/uploads\/[0-9a-f-]{36}$/.test(objectPath) ||
    !/^[a-f0-9]{64}$/.test(processedSha256)
  ) {
    return false;
  }
  const { db, uploadGrantsTable } = await import("@workspace/db");
  const rows = await db
    .update(uploadGrantsTable)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(uploadGrantsTable.id, grantId),
        eq(uploadGrantsTable.requestedBy, requestedBy),
        eq(uploadGrantsTable.objectPath, objectPath),
        eq(uploadGrantsTable.status, "processed"),
        isNotNull(uploadGrantsTable.processedAt),
        eq(uploadGrantsTable.processedSha256, processedSha256),
        isNull(uploadGrantsTable.claimedAt),
        gt(uploadGrantsTable.expiresAt, new Date()),
      ),
    )
    .returning({ id: uploadGrantsTable.id });
  return rows.length === 1;
}
