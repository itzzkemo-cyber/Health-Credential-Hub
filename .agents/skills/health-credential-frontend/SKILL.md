---
name: health-credential-frontend
description: Build or review Health Credential Hub responsive web UI changes, including RTL/LTR behavior, navigation, credential forms, QR verification, uploads, generated API hooks, and accessibility. Use for work under artifacts/health-docs.
---

# Health Credential Frontend

1. Read `AGENTS.md`, then identify the affected Vite web journey and API contract.
2. Use hooks from `@workspace/api-client-react`; do not duplicate API contracts or trust client-side role checks as authorization.
3. Preserve Arabic/English and RTL/LTR parity. Test keyboard use, labels, focus, mobile layout, loading, empty, error, and permission-denied states.
4. Keep credential uploads at the server/OCR limit, disclose OCR before upload, avoid persisting sensitive data unnecessarily, and never expose private object URLs.
5. Build QR links from configured base URLs; never hardcode deployment paths or domains.
6. Run the affected package `typecheck`, tests, and production build.
