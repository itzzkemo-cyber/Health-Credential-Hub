---
name: health-credential-api
description: Develop or review Health Credential Hub Express routes, OpenAPI contracts, generated clients, Drizzle schemas, migrations, authentication, RBAC, audit events, reports, and background jobs. Use for API or database changes.
---

# Health Credential API

1. Read `AGENTS.md`. Treat `lib/api-spec/openapi.yaml` as the contract source and regenerate clients after edits.
2. Enforce facility/team scope in the database query or immediately after a bounded query. Reuse `getScopedUsers`; only `system_admin` is global.
3. Validate identifiers, dates, sizes, roles, and organizational references server-side. Employees cannot self-verify or alter role/scope.
4. Record durable audit events without secrets or document content. Prefer soft deletion for credential-workforce records.
5. Add reviewed Drizzle migrations for schema changes. Never use `push-force` on shared environments.
6. Keep optional providers lazy so the API can start without unused integrations. Run root typecheck, API build, and contract codegen drift checks.
