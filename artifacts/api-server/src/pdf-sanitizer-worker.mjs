// SECURITY BOUNDARY: This entry is executed only in a bounded child process.
// Never import it into the API request process; never accept URLs or filenames.
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFHexString,
  PDFString,
} from "pdf-lib";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_PAGE_PIXELS = 2_500_000;
const MAX_TOTAL_PIXELS = 12_000_000;
const MAX_SOURCE_IMAGE_PIXELS = 12_000_000;
const MAX_OBJECTS = 10_000;
const MAX_DEPTH = 64;
const MAX_EXTRACTED_TEXT_BYTES = 24 * 1024;
const RENDER_SCALE = 1.5;
const WORKER_FRAME_MAGIC = Buffer.from("HDP1", "ascii");

// Reject rather than silently removing evidence-bearing signatures/forms.
// Object names are decoded by the PDF parser, including #xx-escaped names and
// compressed object streams; string/regex searches alone are not authoritative.
const FORBIDDEN_KEYS = new Set([
  "AA",
  "OpenAction",
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFiles",
  "EF",
  "AcroForm",
  "XFA",
  "RichMediaContent",
  "RichMediaSettings",
  "Collection",
  "ByteRange",
  "Sig",
  "Encrypt",
  "SubmitForm",
  "ImportData",
  "GoToR",
  "GoToE",
  "Dest",
  "Ref",
]);
const FORBIDDEN_NAMES = new Set([
  "JavaScript",
  "Launch",
  "EmbeddedFile",
  "Filespec",
  "RichMedia",
  "Movie",
  "Sound",
  "Screen",
  "FileAttachment",
  "Widget",
  "Sig",
  "SubmitForm",
  "ImportData",
  "GoToR",
  "GoToE",
  "Rendition",
  "3D",
  "XFA",
  "URI",
  "GoTo",
  "Named",
  "Hide",
  "SetOCGState",
  "JPXDecode",
  "JBIG2Decode",
]);

function reject() {
  throw new Error("Rejected PDF");
}

function decodedName(value) {
  return value instanceof PDFName ? value.decodeText() : null;
}

function isPdfTextString(value) {
  return value instanceof PDFString || value instanceof PDFHexString;
}

function encodeBoundedMetadata(text) {
  let bounded = text;
  while (true) {
    const metadata = Buffer.from(JSON.stringify({ text: bounded }), "utf8");
    if (metadata.length <= MAX_EXTRACTED_TEXT_BYTES) return metadata;
    const bytes = Buffer.from(bounded, "utf8");
    const nextSize = Math.max(0, Math.min(bytes.length - 1, Math.floor(bytes.length * 0.75)));
    bounded = bytes
      .subarray(0, nextSize)
      .toString("utf8")
      .replace(/\uFFFD+$/g, "");
  }
}

/**
 * Hyperlink annotations are never copied into the rebuilt document. Allow only
 * this narrow, inert shape so ordinary issuer links do not make an otherwise
 * flat certificate unusable. All other actions remain fail-closed.
 */
function isDiscardableLinkAnnotation(dictionary, context) {
  if (
    decodedName(dictionary.get(PDFName.of("Type"))) !== "Annot" ||
    decodedName(dictionary.get(PDFName.of("Subtype"))) !== "Link" ||
    dictionary.has(PDFName.of("AA"))
  ) {
    return false;
  }

  const actionReference = dictionary.get(PDFName.of("A"));
  const destination = dictionary.get(PDFName.of("Dest"));
  if (!actionReference || destination) return false;

  // Deliberately reject indirect actions: skipping a reference would create a
  // blind spot when the referenced graph is visited elsewhere. A tiny inline
  // URI action is sufficient for normal issuer hyperlinks.
  if (actionReference instanceof PDFRef) return false;
  const action = actionReference;
  if (!(action instanceof PDFDict)) return false;
  const actionType = decodedName(action.get(PDFName.of("S")));
  if (actionType !== "URI") return false;
  const allowedKeys = new Set(["S", "URI"]);
  for (const [key] of action.entries()) {
    if (!allowedKeys.has(key.decodeText())) return false;
  }
  const uri = action.get(PDFName.of("URI"));
  if (!isPdfTextString(uri)) return false;
  const value = uri.decodeText();
  if (value.length > 2_048 || !/^(?:https?:|mailto:)/i.test(value))
    return false;
  return true;
}

async function preflight(input) {
  const source = await PDFDocument.load(input, {
    ignoreEncryption: false,
    updateMetadata: false,
    throwOnInvalidObject: true,
  });
  if (source.isEncrypted || source.context.trailerInfo.Encrypt) reject();
  const pages = source.getPages();
  if (pages.length < 1 || pages.length > MAX_PAGES) reject();
  const objects = source.context.enumerateIndirectObjects();
  if (objects.length > MAX_OBJECTS) reject();
  const visited = new Set();
  let visits = 0;
  let sourceImagePixels = 0;
  const visit = (raw, depth = 0) => {
    if (depth > MAX_DEPTH || ++visits > MAX_OBJECTS * 10) reject();
    const value = raw instanceof PDFRef ? source.context.lookup(raw) : raw;
    if (!value || visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFName && FORBIDDEN_NAMES.has(value.decodeText()))
      reject();
    const dictionary = value instanceof PDFRawStream ? value.dict : value;
    // External stream files are not a supported data source, even when a PDF
    // renderer would choose to ignore them rather than issue a hard error.
    if (value instanceof PDFRawStream && dictionary.has(PDFName.of("F")))
      reject();
    if (dictionary instanceof PDFDict) {
      const discardableLink = isDiscardableLinkAnnotation(
        dictionary,
        source.context,
      );
      if (dictionary.get(PDFName.of("Subtype"))?.toString() === "/Image") {
        const width = dictionary
          .lookup(PDFName.of("Width"), PDFNumber)
          .asNumber();
        const height = dictionary
          .lookup(PDFName.of("Height"), PDFNumber)
          .asNumber();
        if (
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width < 1 ||
          height < 1
        )
          reject();
        sourceImagePixels += width * height;
        if (sourceImagePixels > MAX_SOURCE_IMAGE_PIXELS) reject();
      }
      for (const [key, child] of dictionary.entries()) {
        if (FORBIDDEN_KEYS.has(key.decodeText())) reject();
        // The action/destination has already been strictly validated above and
        // is deliberately omitted from the image-only output.
        if (
          discardableLink &&
          (key.decodeText() === "A" || key.decodeText() === "Dest")
        )
          continue;
        visit(child, depth + 1);
      }
    } else if (value instanceof PDFArray) {
      for (let index = 0; index < value.size(); index++)
        visit(value.get(index), depth + 1);
    }
  };
  for (const [, object] of objects) visit(object);
  return pages.length;
}

class BoundedCanvasFactory {
  create(width, height) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > MAX_SOURCE_IMAGE_PIXELS
    )
      reject();
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(target, width, height) {
    if (width < 1 || height < 1 || width * height > MAX_SOURCE_IMAGE_PIXELS)
      reject();
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target) {
    target.canvas.width = 0;
    target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}

async function rebuild(input, extractText) {
  const count = await preflight(input);
  // No document-controlled fetch: data bytes only; local packaged font/CMap
  // assets only; no JavaScript evaluator, XFA, WASM, or remote worker sources.
  globalThis.fetch = async () => {
    throw new Error("Network disabled");
  };
  const require = createRequire(import.meta.url);
  const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: Uint8Array.from(input),
    verbosity: 0,
    isEvalSupported: false,
    stopAtErrors: true,
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: MAX_SOURCE_IMAGE_PIXELS,
    canvasMaxAreaInBytes: MAX_SOURCE_IMAGE_PIXELS * 4,
    cMapUrl: path.join(pdfRoot, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfRoot, "standard_fonts") + "/",
    CanvasFactory: BoundedCanvasFactory,
  });
  try {
    const document = await task.promise;
    if (document.numPages !== count) reject();
    const output = await PDFDocument.create({ updateMetadata: false });
    let totalPixels = 0;
    const extractedTextParts = [];
    let extractedTextBytes = 0;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const pixels = width * height;
      totalPixels += pixels;
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1 ||
        pixels > MAX_PAGE_PIXELS ||
        totalPixels > MAX_TOTAL_PIXELS
      )
        reject();
      if (extractText) {
        const textContent = await page.getTextContent({
          includeMarkedContent: false,
        });
        const pageText = textContent.items
          .map((item) => (typeof item?.str === "string" ? item.str : ""))
          .join(" ")
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
          .replace(/[ \t]+/g, " ")
          .trim();
        if (pageText) {
          const remaining = MAX_EXTRACTED_TEXT_BYTES - extractedTextBytes;
          if (remaining > 0) {
            const bounded = Buffer.from(pageText, "utf8").subarray(0, remaining);
            // Avoid ending on an incomplete UTF-8 sequence.
            const normalized = bounded
              .toString("utf8")
              .replace(/\uFFFD+$/g, "");
            extractedTextParts.push(normalized);
            extractedTextBytes += Buffer.byteLength(normalized, "utf8");
          }
        }
      }
      pages.push({ page, viewport, width, height });
    }
    let totalImageBytes = 0;
    for (const { page, viewport, width, height } of pages) {
      const canvas = createCanvas(width, height);
      try {
        await page.render({
          canvas,
          canvasContext: canvas.getContext("2d"),
          viewport,
          background: "rgb(255,255,255)",
          annotationMode: pdfjs.AnnotationMode.DISABLE,
        }).promise;
        const jpeg = canvas.toBuffer("image/jpeg", 90);
        totalImageBytes += jpeg.length;
        if (totalImageBytes > MAX_BYTES) reject();
        const image = await output.embedJpg(jpeg);
        const rebuiltPage = output.addPage([
          width / RENDER_SCALE,
          height / RENDER_SCALE,
        ]);
        rebuiltPage.drawImage(image, {
          x: 0,
          y: 0,
          width: rebuiltPage.getWidth(),
          height: rebuiltPage.getHeight(),
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }
    const bytes = await output.save({ useObjectStreams: false });
    if (bytes.length === 0 || bytes.length > MAX_BYTES) reject();
    return {
      bytes,
      text: extractedTextParts.join("\n"),
    };
  } finally {
    await task.destroy();
  }
}

async function readInput() {
  if (process.argv.includes("--self-test")) {
    const fixture = await PDFDocument.create({ updateMetadata: false });
    fixture
      .addPage([72, 72])
      .drawRectangle({ x: 8, y: 8, width: 56, height: 56 });
    return Buffer.from(await fixture.save({ useObjectStreams: false }));
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) reject();
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks, size);
  if (
    size === 0 ||
    !/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(
      input.subarray(0, 10).toString("ascii"),
    )
  )
    reject();
  return input;
}

// Suppress library diagnostics so neither stdin data nor metadata can leak.
console.log = console.warn = console.error = () => {};
try {
  const result = await rebuild(
    await readInput(),
    process.argv.includes("--extract-text"),
  );
  // JSON escaping can expand quotes, backslashes and page separators. Truncate
  // the optional review text instead of rejecting an otherwise safe PDF.
  const metadata = encodeBoundedMetadata(result.text);
  const header = Buffer.alloc(8);
  WORKER_FRAME_MAGIC.copy(header, 0);
  header.writeUInt32BE(metadata.length, 4);
  process.stdout.end(Buffer.concat([header, metadata, result.bytes]));
} catch (error) {
  // This mode manufactures its own fixture and never reads document stdin.
  if (process.argv.includes("--self-test"))
    process.stderr.write(String(error?.message ?? "PDF self-test failed"));
  process.exitCode = 64;
}
