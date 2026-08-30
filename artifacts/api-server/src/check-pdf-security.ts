import { checkPdfSanitizerReadiness } from "./lib/pdfSanitizer";

// Container-image gate: uses only a generated fixture, no DB/storage/secrets.
// Keep diagnostics constant; parser output must never become deployment logs.
try {
  await checkPdfSanitizerReadiness();
  process.stdout.write("PDF security self-test passed\n");
} catch {
  process.stderr.write("PDF security self-test failed\n");
  process.exitCode = 1;
}
