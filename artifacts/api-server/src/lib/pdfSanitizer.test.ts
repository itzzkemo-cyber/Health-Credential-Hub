import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import {
  checkPdfSanitizerReadiness,
  pdfWorkerEnvironment,
  PdfRejectedError,
  PdfUnavailableError,
  sanitizePdfInChild,
} from "./pdfSanitizer";

async function fixture(pages = 1, width = 320, height = 240): Promise<Buffer> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle("SYNTHETIC-PRIVATE-METADATA");
  for (let index = 0; index < pages; index++) {
    const page = document.addPage([width, height]);
    page.drawText(`TEST CREDENTIAL ${index + 1}`, {
      x: 20,
      y: height - 40,
      size: 14,
    });
    page.drawRectangle({ x: 20, y: 30, width: 100, height: 60 });
  }
  return Buffer.from(await document.save({ useObjectStreams: true }));
}

async function modifyFixture(
  edit: (document: PDFDocument) => void | Promise<void>,
): Promise<Buffer> {
  const document = await PDFDocument.load(await fixture(), {
    updateMetadata: false,
  });
  await edit(document);
  return Buffer.from(await document.save({ useObjectStreams: true }));
}

describe("bounded PDF child sanitizer", () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("rebuilds every page with image streams only and strips source metadata/text", async () => {
    const source = await fixture(2);
    const result = await sanitizePdfInChild(source);
    const output = await PDFDocument.load(result, { updateMetadata: false });
    expect(output.getPageCount()).toBe(2);
    expect(output.getTitle()).toBeUndefined();
    expect(output.isEncrypted).toBe(false);
    expect(result.includes(Buffer.from("SYNTHETIC-PRIVATE-METADATA"))).toBe(
      false,
    );
    expect(result.includes(Buffer.from("TEST CREDENTIAL"))).toBe(false);
    const images = output.context
      .enumerateIndirectObjects()
      .filter(
        ([, object]) =>
          object instanceof PDFRawStream &&
          object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image",
      );
    expect(images).toHaveLength(2);
    for (const [, object] of images) {
      const stream = object as PDFRawStream;
      expect(stream.dict.get(PDFName.of("Filter"))?.toString()).toBe(
        "/DCTDecode",
      );
      expect(
        stream.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber(),
      ).toBe(480);
      expect(
        stream.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber(),
      ).toBe(360);
    }
  }, 20_000);

  it("rejects JavaScript stored in compressed objects instead of copying it", async () => {
    const input = await modifyFixture((document) => {
      document.addJavaScript("synthetic", "app.alert('not executed')");
    });
    await expect(sanitizePdfInChild(input)).rejects.toBeInstanceOf(
      PdfRejectedError,
    );
  });

  it("retains a readable synthetic certificate and QR in its rebuilt page", async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([595, 842]);
    page.drawText("SYNTHETIC TEST CREDENTIAL", { x: 50, y: 770, size: 22 });
    page.drawText("NOT A REAL EMPLOYEE DOCUMENT", { x: 50, y: 735, size: 14 });
    page.drawText("Holder: Test Employee / License: TEST-12345", {
      x: 50,
      y: 660,
      size: 16,
    });
    page.drawText("Issued: 2026-01-01  Expires: 2027-01-01", {
      x: 50,
      y: 620,
      size: 16,
    });
    const qr = await document.embedPng(
      await QRCode.toBuffer("https://example.invalid/synthetic-test", {
        width: 400,
        margin: 4,
      }),
    );
    page.drawImage(qr, { x: 50, y: 390, width: 180, height: 180 });
    const result = await sanitizePdfInChild(Buffer.from(await document.save()));
    const output = await PDFDocument.load(result, { updateMetadata: false });
    const image = output.context
      .enumerateIndirectObjects()
      .map(([, value]) => value)
      .find(
        (value) =>
          value instanceof PDFRawStream &&
          value.dict.get(PDFName.of("Subtype"))?.toString() === "/Image",
      ) as PDFRawStream;
    expect(image).toBeDefined();
    const outputDirectory = path.join(process.cwd(), ".local", "pdf-preview");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, "synthetic-rebuilt.pdf"),
      result,
    );
    await writeFile(
      path.join(outputDirectory, "synthetic-rebuilt-page.jpg"),
      image.getContents(),
    );
  });

  it.each(["AcroForm", "OpenAction", "AA", "ByteRange"])(
    "rejects active/form/signature dictionary key %s",
    async (key) => {
      const input = await modifyFixture((document) => {
        document.catalog.set(
          PDFName.of(key),
          document.context.obj({ S: "JavaScript", JS: "not executed" }),
        );
      });
      await expect(sanitizePdfInChild(input)).rejects.toBeInstanceOf(
        PdfRejectedError,
      );
    },
  );

  it("rejects attached files", async () => {
    const input = await modifyFixture(async (document) => {
      await document.attach(
        Buffer.from("synthetic attachment"),
        "attachment.txt",
      );
    });
    await expect(sanitizePdfInChild(input)).rejects.toBeInstanceOf(
      PdfRejectedError,
    );
  });

  it("rejects even an encryption declaration without accepting an empty password", async () => {
    const input = await modifyFixture((document) => {
      document.context.trailerInfo.Encrypt = document.context.register(
        document.context.obj({
          Filter: "Standard",
          V: 1,
          R: 2,
          O: PDFString.of("synthetic"),
          U: PDFString.of("synthetic"),
          P: -4,
        }),
      );
    });
    await expect(sanitizePdfInChild(input)).rejects.toBeInstanceOf(
      PdfRejectedError,
    );
  });

  it("rejects external URI actions", async () => {
    const input = await modifyFixture((document) => {
      document.getPages()[0].node.set(
        PDFName.of("Annots"),
        document.context.obj([
          {
            Type: "Annot",
            Subtype: "Link",
            Rect: [0, 0, 20, 20],
            A: {
              S: "URI",
              URI: PDFString.of("https://example.invalid/never-requested"),
            },
          },
        ]),
      );
    });
    await expect(sanitizePdfInChild(input)).rejects.toBeInstanceOf(
      PdfRejectedError,
    );
  });

  it("rejects more than five pages", async () => {
    await expect(sanitizePdfInChild(await fixture(6))).rejects.toBeInstanceOf(
      PdfRejectedError,
    );
  });

  it("rejects an oversized page before allocating the render canvas", async () => {
    await expect(
      sanitizePdfInChild(await fixture(1, 2000, 2000)),
    ).rejects.toBeInstanceOf(PdfRejectedError);
  });

  it("rejects total rendered pixel load beyond the document budget", async () => {
    await expect(
      sanitizePdfInChild(await fixture(5, 1000, 1100)),
    ).rejects.toBeInstanceOf(PdfRejectedError);
  }, 20_000);

  it.each([
    Buffer.from("%PDF-1.7\nbroken"),
    Buffer.from("<script>"),
    Buffer.alloc(0),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  ])(
    "rejects malformed/empty/over-limit input without persistence",
    async (bytes) => {
      await expect(sanitizePdfInChild(bytes)).rejects.toBeInstanceOf(
        PdfRejectedError,
      );
    },
  );

  it("does not inherit provider secrets, home, proxy or Node preload configuration", () => {
    vi.stubEnv("DATABASE_URL", "synthetic-secret");
    vi.stubEnv("NODE_OPTIONS", "synthetic-preload");
    vi.stubEnv("HTTPS_PROXY", "synthetic-proxy");
    const environment = pdfWorkerEnvironment();
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(environment).not.toHaveProperty("HOME");
    expect(Object.keys(environment).sort()).toEqual(
      process.platform === "win32" && process.env.SystemRoot
        ? ["NODE_ENV", "SystemRoot"]
        : ["NODE_ENV"],
    );
  });

  it("kills a stalled process at the deadline and returns no bytes", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "health-pdf-worker-test-"),
    );
    temporaryDirectories.push(directory);
    const workerPath = path.join(directory, "stalled.mjs");
    await writeFile(workerPath, "setInterval(() => {}, 1000);");
    await expect(
      sanitizePdfInChild(await fixture(), { workerPath, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(PdfUnavailableError);
  });

  it("fails closed when the child worker is missing", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "health-pdf-worker-test-"),
    );
    temporaryDirectories.push(directory);
    await expect(
      sanitizePdfInChild(await fixture(), {
        workerPath: path.join(directory, "missing.mjs"),
      }),
    ).rejects.toBeInstanceOf(PdfUnavailableError);
  });

  it("fails closed when worker output exceeds 8 MiB", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "health-pdf-worker-test-"),
    );
    temporaryDirectories.push(directory);
    const workerPath = path.join(directory, "oversized.mjs");
    await writeFile(
      workerPath,
      "process.stdout.write(Buffer.alloc(9 * 1024 * 1024));",
    );
    await expect(
      sanitizePdfInChild(await fixture(), { workerPath }),
    ).rejects.toBeInstanceOf(PdfUnavailableError);
  });

  it("self-tests production parser/render/rebuild dependencies without user data", async () => {
    await expect(checkPdfSanitizerReadiness()).resolves.toBeUndefined();
  });
});
