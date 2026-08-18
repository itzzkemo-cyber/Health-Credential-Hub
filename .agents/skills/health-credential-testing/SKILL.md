---
name: health-credential-testing
description: Plan, add, or run risk-based verification for Health Credential Hub across web, Expo, API, database, generated contracts, storage, and Demo flows. Use for regressions, CI, releases, or new test harnesses.
---

# Health Credential Testing

1. Inspect existing scripts first. Never claim lint/tests ran when no real configuration or test files exist.
2. Always run frozen install, root typecheck, generated-client drift check, and affected builds.
3. Prioritize authorization matrices across two facilities and every role; cover self-edit, self-verification, audit-log scope, report scope, object ACL, QR verification, and disabled Demo/registration in production.
4. Use disposable databases and storage prefixes. Never seed, truncate, or upload documents to a shared environment.
5. For UI, cover Arabic/English, RTL/LTR, narrow viewports, keyboard navigation, upload failure, OCR review, and expired/unverified credentials.
6. Record exact commands, environment assumptions, pass/fail/skip counts, and unresolved coverage gaps.
