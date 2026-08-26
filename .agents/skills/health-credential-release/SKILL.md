---
name: health-credential-release
description: Prepare Health Credential Hub's responsive web application for a safe production release or stakeholder handoff. Use for release readiness, operator setup, delivery documentation, and final verification.
---

# Health Credential Release

1. Read `AGENTS.md` and confirm the release target and approved infrastructure. Never present a successful build as a live production deployment.
2. Keep the responsive web app primary. Preserve the API and reference clients unless scope explicitly changes; deploy only the production web artifact.
3. Keep public account creation, seed paths, test-only authentication, sample runtime data, and unapproved provider controls out of production bundles.
4. Production integrations must fail closed. Keep OCR, email, automation, and storage providers disabled until their credentials, privacy terms, region, retention, and operator runbooks are approved.
5. Verify frozen install, generated-client drift, root typecheck, real automated tests, and affected builds. Exercise the employee journey on a narrow viewport in Arabic and English: sign in, review dashboard, list documents, upload manually, inspect status, and delete when authorized.
6. Before delivery, scan the diff for secrets and generated artifacts, document exact start commands and environment requirements, list unavailable external services honestly, and report the commit plus remote CI result when publishing is authorized.
