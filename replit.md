# وثائقي الصحي | HealthDocs

Healthcare credential management platform for Saudi hospitals — tracks professional certificates (BLS, ACLS, SCFHS licenses, iqamas…) with expiry intelligence, compliance dashboards, OCR intake, and QR verification. Arabic-first (RTL) with full English support.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (managed workflow "API Server")
- `pnpm --filter @workspace/health-docs run dev` — web app (managed workflow "web", served at /health-docs/)
- `pnpm --filter @workspace/mobile run dev` — Expo mobile app (served at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks + Zod schemas from `lib/api-spec/openapi.yaml`
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Seed demo data: `cd artifacts/api-server && npx esbuild src/seed.ts --bundle --platform=node --format=cjs --outfile=/tmp/seed.cjs --log-level=error && node /tmp/seed.cjs`
- Required env: `DATABASE_URL`, `SESSION_SECRET` (JWT signing), plus the App Storage vars auto-set at provisioning (`DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`). Optional: `DEMO_LOGIN_ENABLED=false` disables the one-click demo sign-in endpoint (do this before going live with real data).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + JWT auth (bcryptjs + jsonwebtoken)
- DB: PostgreSQL + Drizzle ORM
- Web: React + Vite + Tailwind + shadcn/ui + wouter + TanStack Query (Orval-generated hooks)
- Mobile: Expo / React Native (currently mock data, not yet wired to API)
- API codegen: Orval (from OpenAPI spec)

## Where things live

- `lib/api-spec/openapi.yaml` — **source of truth for the API contract**. Edit → run codegen → implement server routes to match.
- `lib/db/src/schema/` — Drizzle schema, one file per table (facilities, departments, users, credentials, notifications, audit-logs, credential-policies)
- `artifacts/api-server/src/routes/` — one router per domain; `src/lib/auth.ts` (JWT + role middleware), `src/lib/helpers.ts` (status computation, scoping, stats, audit, notifications)
- `artifacts/api-server/src/lib/email/` — expiry alert emails: `templates.ts` (bilingual branded HTML), `sender.ts` (provider adapter), `dispatch.ts` (ledger-idempotent sending + weekly digests), `scheduler.ts` (hourly job)
- `artifacts/api-server/src/seed.ts` — demo dataset (12 users, 4 departments, 44 credentials)
- `artifacts/health-docs/src/` — web frontend (pages/, components/, lib/i18n.tsx, lib/auth.ts)
- `artifacts/mobile/` — Expo app, fully wired to the real API (auth, credentials, notifications, dashboard)

## Architecture decisions

- Credential **status is computed at read time** from expiryDate (expired / expiring_soon ≤90d / active) — never stored, so it can't go stale.
- **Role scoping** lives in `getScopedUsers()` (api-server/src/lib/helpers.ts): employee→self, supervisor→direct reports+self, department_manager→own department, admins→whole facility. Every list endpoint filters through it.
- **Compliance rate** = non-expired credentials / (credentials + missing-required) per employee; departments/facility average per-employee rates.
- Missing credentials are derived from `credential_policies` (type required for role/department) vs. what the employee holds unexpired.
- **Sessions**: the JWT (7d, SESSION_SECRET-signed) is delivered as an httpOnly `SameSite=None; Secure` cookie (`healthdocs_session`) — never stored in web JS/localStorage, so XSS can't exfiltrate it. Tokens embed `v` = `users.session_version`; `requireAuth` rejects mismatches, and password reset/change bumps the version — instant revocation of all other sessions (change-password re-issues the caller's cookie + returns a fresh `token`). Password reset: `POST /auth/forgot-password` (enumeration-safe 200, single active link, 1h TTL, sha256-at-rest tokens in `password_reset_tokens`) → emailed link to web `/reset-password` → `POST /auth/reset-password` (atomic single-use claim, auto-login; 400 `code`: `invalid_token` vs `weak_password`). SameSite must stay `None`: the Replit workspace preview embeds the app in a cross-site iframe where Strict/Lax cookies silently fail (login/logout break in the preview pane). The login response also returns the token in the body for native/mobile clients, which authenticate via `Authorization: Bearer` (both paths supported in `requireAuth`; header wins). Web logout must call POST /auth/logout — JS cannot clear an httpOnly cookie.
- **CORS/CSRF**: CORS headers are only emitted for first-party origins (from `REPLIT_DOMAINS` + `REPLIT_EXPO_DEV_DOMAIN`). With SameSite=None, `csrfOriginGuard` (app.ts) is the primary CSRF defense: mutations that ride the session cookie — or hit the session-issuing login endpoints — must present a first-party `Origin` when one is sent (localhost trusted in dev only, for local tooling). JSON-only body parsing (no urlencoded) closes the classic `<form>` vector.
- **Demo sign-in**: POST /auth/demo-login `{role}` logs into the seeded showcase accounts entirely server-side — no passwords ship in the client bundle. Kill switch: `DEMO_LOGIN_ENABLED=false` (also deactivate the demo users) before real rollout. Demo login deliberately bypasses 2FA (showcase accounts).
- **2FA (TOTP)**: opt-in per user (settings → Security card). Enrollment: `POST /auth/totp/setup` returns secret+QR+`setupToken` (10min JWT carrying the secret — nothing persisted until `POST /auth/totp/verify-setup` proves possession, which activates and returns 8 single-use backup codes, sha256-hashed at rest in `users.backup_codes` jsonb). Login/reset-password for 2FA accounts answer **202 `{pending2fa, challengeToken}`** (5min purpose-JWT) instead of a session; web stores it in sessionStorage → `/2fa-challenge` page; `POST /auth/totp/challenge` verifies OTP (±1 step, `totp_last_used_step` forward-only guard blocks replay) or backup code (atomic jsonb removal = single use), enforces ≤5 attempts per challenge (in-memory, single-use jti). Purpose tokens (`purpose: 2fa_challenge|totp_setup`) are **rejected by `requireAuth`** — they can never act as sessions. Disable/regenerate-backup require password **and** a second factor; `POST /auth/totp/admin-disable` lets hospital_admin (own facility, 404 outside) / system_admin rescue locked-out users (audited). Error codes: `invalid_code`, `expired_challenge`, `too_many_attempts`, `setup_expired`, `wrong_password`. Mobile: login screen swaps to an inline code step on `pending2fa`.
- QR verification (`/credentials/{qrToken}/verify`) is deliberately **public** (no auth) — it's the external verification surface.
- OCR extraction is **real AI reading**: `POST /credentials/ocr` loads the stored object (image/PDF ≤ 8MB, same allowlist as upload presign), sends it inline to Gemini `gemini-2.5-flash` via Replit AI Integrations (`@workspace/integrations-gemini-ai`, billed to workspace credits — no own API key), with a strict-JSON prompt and server-side sanitization (type whitelist → `custom` fallback, `YYYY-MM-DD` date regex, confidences clamped 0..1, never invent → nulls). Guards: ACL check (managers bypass), first-read owner claim on fresh un-ACL'd uploads, per-user rate limit 20/10min (429). The web UI shows a "review before saving" notice; the mobile app still uses its local demo simulation until wired to the real API.
- **Credential files live in App Storage (GCS)**, not the DB: the browser compresses images (≤2000px JPEG), requests a presigned URL (`POST /api/storage/uploads/request-url`), PUTs bytes straight to GCS, and saves only the `/objects/uploads/<uuid>` path in `credentials.fileUrl`. Serving goes through authenticated `GET /api/storage/objects/*` — ACL owner (= credential's employee) or any manager role. ACL is stamped in the credentials create/PATCH routes (`finalizeStoredFileUrl`), which reject any fileUrl that is not an existing `/objects/...` storage object — inline base64 `data:` URLs can no longer be persisted. All legacy rows were migrated long ago (DB holds storage paths only), so the blob fallback and the one-off migration script were removed; `src/lib/file-preview.ts` now just resolves storage paths to the authenticated serving route.

## Product

- 5 roles: employee, supervisor, department_manager, hospital_admin, system_admin — role-adaptive dashboards and navigation
- Credential CRUD with 21 types, manual + smart-OCR intake modes, duplicate detection, tags/notes/file attachment
- Expiry intelligence: notifications at 90/60/30/15/7/1-day thresholds, missing-credential detection from policies
- **Email alerts**: hourly scheduler (`lib/email/scheduler.ts`) syncs expiry notifications for ALL active users (not just logged-in) and emails each new one exactly once. `email_log` is a **claim-first idempotency ledger**: a `sending` row is inserted with ON CONFLICT DO NOTHING against DB unique indexes (unique `notification_id`; unique `user_id+week_key` for digests) *before* sending, so concurrent dispatchers (hourly tick, on-activity trigger, multiple instances) can never double-send; the row then flips to `sent`/`failed` — one attempt, no auto-retry. Weekly supervisor/department-manager digest of at-risk team members goes out Sundays ≥07:00 Riyadh. On-activity dispatch (GET /notifications, 5-min throttle) shortens delivery delay. Kill switch: `EMAIL_ALERTS_DISABLED=1`. **Provider: Resend via the Replit-managed connector** (`sender.ts` uses `@replit/connectors-sdk` `connectors.proxy("resend", "/emails")`; credentials injected server-side, never in env). Sender identity defaults to `HealthDocs <onboarding@resend.dev>`; override with `EMAIL_FROM` once a custom domain is verified. Contract: 401/403 from the proxy → `EmailNotConfiguredError` (releases the ledger claim, alert stays pending); any other error = real delivery failure (consumes the attempt). **Fixture suppression**: recipients under demo/test domains (`healthdocs.sa`, `hospital.sa` — see `isFixtureRecipient`) are never actually emailed; dispatch marks their ledger rows `skipped`, forgot-password creates the link but skips the send.
- Compliance dashboards, department drill-downs, exportable reports, audit trail, public QR verification page
- Demo accounts (seed password `demo1234`, used server-side only): admin@ / hospital@ / dept@ / supervisor@ / employee@ healthdocs.sa — login page signs into them via /auth/demo-login without exposing credentials

## User preferences

- User communicates in Arabic — reply in Arabic
- Wants the full spec delivered ("انجز التطبيق") — bias to completing scope autonomously

## Gotchas

- OpenAPI spec must use `type: number` (never `type: integer`) — Orval emits `z.int()` which Zod v3 lacks
- Express routers: always path-scope auth middleware (`router.use("/prefix", requireAuth)`) — an unscoped `router.use(requireAuth)` in any router intercepts ALL requests mounted after it, breaking public routes
- After editing `lib/db` schema, run `pnpm -w run typecheck:libs` (tsc --build) or dependent packages won't see new exports
- Frontend must call APIs via the artifact base path (`/api` baseUrl is set in orval config; web served under /health-docs/)
- `mobile/server/serve.js` (static Expo prod server) is hardened against path traversal: root-anchored posix normalize + `path.sep` boundary check, manifest platforms whitelisted. The `fs-express` SAST rule still pattern-matches any URL→readFile flow — the remaining hit carries a justified `nosemgrep` annotation; keep it if the file is edited.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
