# Health Credential Hub agent guide

## Scope and sources of truth

- This is a pnpm monorepo. Use Node 24 and pnpm 11.19.0.
- `lib/api-spec/openapi.yaml` is the API contract source of truth. After contract changes, run `pnpm --filter @workspace/api-spec run codegen`; do not hand-edit generated clients.
- Drizzle schemas live in `lib/db/src/schema`. Generate reviewed migrations for production changes; never use `push-force` on shared data.
- Preserve the responsive web application and API unless a task explicitly changes product scope. The current release is production-only and must not reintroduce test-only login or synthetic runtime data.
- Treat `artifacts/health-docs` as the product UI. New employee journeys must work at 390px width.

## Required checks

- Install with `pnpm install --frozen-lockfile`.
- Run `pnpm run typecheck` after code changes.
- Run the affected package builds.
- Do not add lint/test CI steps unless matching configuration and real tests exist.

## Healthcare and security rules

- Treat credential documents, employee profiles, OCR payloads, audit events, and contact data as sensitive workforce information; they may incidentally include health data.
- Never log tokens, passwords, TOTP secrets, document bodies, presigned URLs, OCR Base64, or sensitive environment values.
- Every employee, credential, report, audit, and stored-object query must enforce facility/team scope server-side. UI visibility is not authorization.
- Public account creation and destructive seed paths are not part of the release. Administrators provision scoped accounts through authenticated workflows.
- Employees must not verify their own credentials or change their organizational scope. Preserve audit history with soft deletion.
- Keep uploads private, size/type constrained, and ACL-checked. Any new external processor requires documented data flow, retention, region, failure handling, and operator setup.

## Working style

- Keep changes small and contract-compatible; update Arabic and English UI copy together.
- Prefer accessible controls, keyboard navigation, mobile-web layouts, and RTL/LTR parity.
- Add or update `.env.example` with empty/safe placeholders when introducing configuration; never commit real secrets.
- Document remaining production dependencies honestly rather than simulating unavailable services.
- Use `$health-credential-release` and the release engineer for delivery work. Local test fixtures are never a substitute for production infrastructure.
