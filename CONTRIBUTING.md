# Contributing

1. Use Node 24 and pnpm 11.19.0.
2. Create a focused branch and keep unrelated generated or build output out of commits.
3. Update OpenAPI first for API contract changes, then regenerate the clients.
4. Add a Drizzle migration for schema changes and explain rollback/data impact.
5. Run `pnpm install --frozen-lockfile`, `pnpm run typecheck`, and the affected builds.
6. Describe privacy, tenant-isolation, Demo, and environment-variable impact in the pull request.

Do not commit credentials, production data, screenshots containing employee records, or document samples with personal information.

