# Private PDF document intake

## Product behavior

- Employees and authorized managers may submit JPEG, PNG, or PDF through the existing authenticated, CSRF-protected, create-only upload grant workflow.
- Inputs and rebuilt outputs are limited to **8 MiB**. PDF inputs are limited to **5 pages**, **2.5 million rendered pixels per page**, and **12 million rendered pixels total**. Source image objects have a combined **12 million pixel** budget. Pages render at 108 DPI (1.5 scale).
- PDF pages become a **new image-only PDF**. The original is not stored. Selectable/searchable text, source metadata, comments and interactive features are not preserved. Users see this notice in Arabic and English before submitting a selected PDF and should keep their original.
- Encrypted PDFs, forms (including AcroForm/XFA), digital signatures, embedded files, JavaScript/actions (including external links), RichMedia, and unsupported JPEG2000/JBIG2 image streams are **rejected**, not silently kept or stripped. The employee should request a flat, unsigned copy from the issuer where appropriate; this service does not attest to an original digital signature.
- Existing JPEG/PNG sanitization remains unchanged. Every PDF uses the separate rebuilder, even if the legacy Windows Defender provider is selected; there is no raw-PDF fallback.
- PDF OCR is deliberately **not enabled**. The API still accepts only image MIME types for the external OCR processor, and the PDF UI does not offer that action. This change adds no new external processor.
- Private downloads retain the existing tenant/role authorization, active-user/session checks, no-store behavior and `nosniff`. PDF preview uses the browser viewer with an open-document fallback for mobile browsers. File preview type is derived from verified storage metadata rather than the browser label.

## Processing boundary and limits

`src/lib/pdfSanitizer.ts` launches `pdf-sanitizer-worker.mjs` with `shell:false`, hidden on Windows, using Node 24. Input/output travel over bounded pipes, not a document temp file. The existing single upload-security slot prevents a worker queue. The child receives no database, storage, mail, OCR, proxy, home or Node-preload environment values; only production mode and Windows `SystemRoot` where required.

The parent enforces a **20-second wall-clock deadline**, kills a timed-out worker, waits for its exit, caps output at 8 MiB and discards bounded parser diagnostics. The child has a **192 MiB V8 heap limit**, constrained file-read permission for its code/dependencies, no Node filesystem-write permission, and no permission to spawn children or workers. Native canvas loading requires the explicit addon permission. PDF parsing has additional object-count/depth limits and canvas allocation checks.

The child parses PDF object dictionaries with `pdf-lib` (including escaped names and compressed object streams) and rejects active or encryption-bearing structures. `pdfjs-dist` renders bytes only, with no document URL, no XFA, no WASM and no remote font/worker sources. Standard fonts/CMaps are loaded only from packaged local dependencies. `fetch` is disabled in the child. `@napi-rs/canvas` produces fresh JPEG pixels; `pdf-lib` writes a newly constructed PDF containing only these page images.

**This is process isolation and bounded reconstruction, not an OS/container security sandbox or an antivirus certification.** Node 24's permission model is defense in depth and does not constrain native addon behavior or provide a network namespace. The V8 heap cap does not cap all native/external memory. Maintain container resource limits, timely dependency patches and appropriate production egress restrictions. For stronger isolation, move this same contract into a dedicated no-network, memory-limited worker container before expanding limits or concurrency. Do not claim malware-free or production compliance from these tests alone.

## Required deployment gates

1. Deploy the API worker and all production dependencies together: `pdfjs-dist`, `@napi-rs/canvas`, and `pdf-lib`. `pnpm --filter @workspace/api-server run build` emits the worker beside `dist/index.mjs`. `node dist/check-pdf-security.mjs` runs the real child boundary and emits a constant success/failure message; run it as the runtime user when building the final container. Native canvas must match the runtime OS/architecture. Test the final Linux image, not only the Windows development machine.
2. In the **private** Supabase bucket, allow exactly `image/jpeg`, `image/png`, and `application/pdf`; maintain the 8 MiB size cap. Adding PDF to a bucket MIME allowlist must not change public access, anonymous/authenticated storage policies, RLS, or service-role boundaries. Keep provider-direct upload URLs disabled.
3. Complete a synthetic upload → link → authenticated download test in the deployment, including a different-tenant denial. A successful unit test does not prove bucket settings or production ACLs.
4. `/api/readyz` runs a synthetic PDF parser/render/rebuild self-test when uploads are enabled. Missing native dependencies or a failing PDF worker must fail readiness. Never disable the sanitizer or substitute raw document storage to pass the probe.
5. Confirm acceptable CPU/RSS and upload latency on the selected Render plan. Limits are conservative but not a guarantee that a small/shared host will never exhaust memory. A timed-out/rejected upload fails closed and needs a smaller, flatter source document.
6. Verify the rebuilt page remains readable, including issuer details, dates and QR/barcodes. Rasterization is intentionally lossy; no pixel-perfect or machine-readable-QR guarantee is made for arbitrary documents.

## Verification performed locally

Synthetic automated coverage includes image-only multi-page rebuild, removal of source metadata/text, compressed JavaScript, active dictionaries, attachments, encryption declaration, URI actions, page/pixel/size limits, missing/stalled/over-output workers, environment minimization, readiness, PDF grant finalization, rejection before storage, and frontend PDF-kind propagation.

`src/lib/pdfSanitizer.test.ts` writes non-sensitive preview artifacts to ignored `.local/pdf-preview/` under the API package. The synthetic certificate/QR was visually inspected after reconstruction: text and QR blocks remain clear. These are test fixtures, never employee documents.

Commands (Node 24, pnpm 11.19.0):

```text
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/health-docs run test
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/health-docs run build:production
git diff --check
```

No production employee documents, production storage mutations, or external OCR calls are used by these tests. Deployment and bucket verification remain separate operator actions.
