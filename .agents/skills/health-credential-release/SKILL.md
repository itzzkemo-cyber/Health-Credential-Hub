---
name: health-credential-release
description: Prepare Health Credential Hub's responsive web application for a safe, reproducible Demo or stakeholder handoff. Use for showcase mode, release readiness, operator setup, delivery documentation, and final verification.
---

# Health Credential Release

1. Read `AGENTS.md` and confirm the handoff target: local showcase, hosted preview, or production. Never present a showcase as production-ready.
2. Keep the responsive web app primary. Preserve the API, Expo, mockup, and role Demo unless scope explicitly changes.
3. A browser-only showcase must use synthetic data, retain selected files in memory only, avoid external OCR/storage/email calls, display a persistent Demo notice, and reset safely on refresh.
4. Production flags must fail closed. Never enable Demo login, destructive seed, self-registration, or OAuth auto-provisioning by default in a production build.
5. Verify frozen install, generated-client drift, root typecheck, real automated tests, and affected builds. Exercise the employee journey on a narrow viewport in Arabic and English: sign in, review dashboard, list documents, upload manually, use simulated smart scan, inspect, and delete.
6. Before delivery, scan the diff for secrets and generated artifacts, document exact start commands and environment requirements, list unavailable external services honestly, and report the commit plus remote CI result when publishing is authorized.
