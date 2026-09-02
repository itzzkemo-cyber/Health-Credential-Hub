import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PDF_SANITIZER_TIMEOUT_MS = 20_000;
export const PDF_SANITIZER_MAX_BYTES = 8 * 1024 * 1024;
export const PDF_SANITIZER_MAX_PAGES = 5;
export const PDF_SANITIZER_MAX_TEXT_BYTES = 24 * 1024;
const PDF_WORKER_FRAME_BYTES = 8;
const PDF_WORKER_FRAME_MAGIC = "HDP1";

export class PdfRejectedError extends Error {}
export class PdfUnavailableError extends Error {}

interface PdfWorkerOptions {
  /** Test-only transport fault injection. Production never accepts a client path. */
  workerPath?: string;
  timeoutMs?: number;
  selfTest?: boolean;
  /** Internal opt-in; normal uploads keep the worker bytes-only. */
  extractText?: boolean;
}

export interface SanitizedPdfResult {
  bytes: Buffer;
  /** Bounded text extracted before the image-only rebuild; never persisted. */
  text: string;
}

function resolveWorkerPath(): string {
  // esbuild emits the worker beside index.mjs. Source-mode Vitest uses the
  // checked-in worker, with exactly the same production process boundary.
  const built = fileURLToPath(
    new URL("./pdf-sanitizer-worker.mjs", import.meta.url),
  );
  if (existsSync(built)) return built;
  if (process.env.NODE_ENV !== "production") {
    return fileURLToPath(
      new URL("../pdf-sanitizer-worker.mjs", import.meta.url),
    );
  }
  throw new PdfUnavailableError();
}

export function pdfWorkerEnvironment(): NodeJS.ProcessEnv {
  // Do not inherit DB, cloud, OAuth, mail, Node preload, HOME, or proxy secrets.
  // SystemRoot is needed to load native dependencies on Windows only.
  return {
    NODE_ENV: "production",
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
}

function workerReadPaths(workerPath: string): string[] {
  const paths = [workerPath];
  let directory = path.dirname(workerPath);
  while (true) {
    const modules = path.join(directory, "node_modules");
    const manifest = path.join(directory, "package.json");
    if (existsSync(modules)) paths.push(modules);
    if (existsSync(manifest)) paths.push(manifest);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return paths;
}

async function runPdfWorker(
  input: Buffer,
  options: PdfWorkerOptions = {},
): Promise<SanitizedPdfResult> {
  if (
    !options.selfTest &&
    (input.length === 0 || input.length > PDF_SANITIZER_MAX_BYTES)
  ) {
    throw new PdfRejectedError();
  }
  const workerPath = options.workerPath ?? resolveWorkerPath();
  const timeoutMs = options.timeoutMs ?? PDF_SANITIZER_TIMEOUT_MS;
  if (
    !path.isAbsolute(workerPath) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(timeoutMs)
  ) {
    throw new PdfUnavailableError();
  }
  return new Promise((resolve, reject) => {
    let outputSize = 0;
    let diagnosticSize = 0;
    let aborted = false;
    const chunks: Buffer[] = [];
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=192",
        "--permission",
        "--allow-addons",
        ...workerReadPaths(workerPath).map(
          (allowed) => `--allow-fs-read=${allowed}`,
        ),
        workerPath,
        ...(options.selfTest ? ["--self-test"] : []),
        ...(options.extractText ? ["--extract-text"] : []),
      ],
      {
        cwd: path.dirname(workerPath),
        env: pdfWorkerEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const abort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (
        outputSize >
        PDF_SANITIZER_MAX_BYTES +
          PDF_SANITIZER_MAX_TEXT_BYTES +
          PDF_WORKER_FRAME_BYTES
      )
        abort();
      else chunks.push(chunk);
    });
    // Parser diagnostics can contain document strings: discard, never log.
    child.stderr.on("data", (chunk: Buffer) => {
      diagnosticSize += chunk.length;
      if (diagnosticSize > 64 * 1024) abort();
    });
    child.stdin.on("error", () => {}); // EPIPE after a fail-closed child exit.
    child.once("error", () => {
      clearTimeout(timer);
      reject(new PdfUnavailableError());
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (aborted || (code !== 0 && code !== 64)) {
        reject(new PdfUnavailableError());
        return;
      }
      if (
        code !== 0 ||
        outputSize <= PDF_WORKER_FRAME_BYTES ||
        outputSize >
          PDF_SANITIZER_MAX_BYTES +
            PDF_SANITIZER_MAX_TEXT_BYTES +
            PDF_WORKER_FRAME_BYTES
      ) {
        reject(new PdfRejectedError());
        return;
      }
      const result = Buffer.concat(chunks, outputSize);
      if (
        result.subarray(0, 4).toString("ascii") !== PDF_WORKER_FRAME_MAGIC
      ) {
        reject(new PdfRejectedError());
        return;
      }
      const metadataLength = result.readUInt32BE(4);
      const pdfOffset = PDF_WORKER_FRAME_BYTES + metadataLength;
      if (
        metadataLength > PDF_SANITIZER_MAX_TEXT_BYTES ||
        pdfOffset >= result.length
      ) {
        reject(new PdfRejectedError());
        return;
      }
      let metadata: unknown;
      try {
        metadata = JSON.parse(
          result
            .subarray(PDF_WORKER_FRAME_BYTES, pdfOffset)
            .toString("utf8"),
        );
      } catch {
        reject(new PdfRejectedError());
        return;
      }
      const text =
        metadata &&
        typeof metadata === "object" &&
        typeof (metadata as { text?: unknown }).text === "string"
          ? (metadata as { text: string }).text
          : null;
      const pdf = result.subarray(pdfOffset);
      if (
        text == null ||
        Buffer.byteLength(text, "utf8") > PDF_SANITIZER_MAX_TEXT_BYTES ||
        pdf.length <= 0 ||
        pdf.length > PDF_SANITIZER_MAX_BYTES ||
        !pdf.subarray(0, 8).toString("ascii").startsWith("%PDF-1.")
      ) {
        reject(new PdfRejectedError());
        return;
      }
      resolve({ bytes: Buffer.from(pdf), text });
    });
    child.stdin.end(input);
  });
}

export async function sanitizePdfWithTextInChild(
  input: Buffer,
  options: PdfWorkerOptions = {},
): Promise<SanitizedPdfResult> {
  return runPdfWorker(input, { ...options, extractText: true });
}

export async function sanitizePdfInChild(
  input: Buffer,
  options: PdfWorkerOptions = {},
): Promise<Buffer> {
  return (await runPdfWorker(input, { ...options, extractText: false })).bytes;
}

export async function checkPdfSanitizerReadiness(): Promise<void> {
  await sanitizePdfInChild(Buffer.alloc(0), { selfTest: true });
}
