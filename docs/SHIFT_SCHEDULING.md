# Monthly shift scheduling

## Release status and scope

This feature adds durable monthly workforce rosters to the existing responsive
web application and API. It does not deploy a service or provision a database.
Apply the reviewed scheduling migration before deploying the matching API/web
revision. A successful local build or disposable-database test is not evidence
that the production migration or employee journey has succeeded.

Draft generation is a deterministic planning heuristic, not an external AI
service, labor-law compliance engine, or clinical staffing approval. It checks
only the configured coverage, unavailable dates, rest interval, consecutive
working days, and monthly shift count. It does not assess qualifications,
credential validity, clinical skill mix, patient demand, overtime, contractual
hours, fairness guarantees, or employment-law requirements. An authorized
manager must approve the inputs and review the resulting roster.

The feature uses existing, active workforce accounts. Clinical supervisors or
managers may be participants, including themselves, when they remain within
the actor's permitted facility/team scope. Scheduling a shift is not permission
to verify a credential or change organizational scope. There is no public account
creation, reference-PDF import, employee-name import, new external processor,
or scheduling provider credential. Do not put real workforce information into
fixtures, source control, screenshots attached to public issues, or logs.

## Manager workflow

1. Sign in with an existing authorized supervisor, department-manager,
   hospital-admin, or system-admin account. Open the shift-scheduling page and
   choose **Manage rosters**. Managers who also work shifts can choose **My
   shifts** (`/schedules?view=mine`) to see only their own published assignments,
   including when they cannot access the complete roster. The personal view
   does not mount management or team-directory queries.
2. Select the month and active workforce participants from one facility within
   your current management scope. A participant can belong to only one active
   saved roster for that month, including drafts. Managers cannot see a complete roster unless every
   participant remains in their current scope.
3. Enter a title, bilingual shift labels, local start/end times, required people
   per shift per day, planning limits, and unavailable dates. Record only dates
   of unavailability, not medical or other private explanations.
4. Generate and save the draft. Check every shortage and warning. A heuristic
   may leave uncovered shifts even when a different arrangement could work;
   use manager review and manual assignment changes, not a claim of
   mathematical infeasibility.
5. Review the month and edit assignments. Saving validates the complete draft;
   two shifts on the same employee/date, unknown participants or shifts,
   unavailable days, and configured work-limit violations are rejected. If
   another manager has saved first, reload the latest roster and reconcile the
   intended changes instead of overwriting it.
6. Publish only after human review. Publishing rechecks current participant
   eligibility, scope, constraints, and full configured coverage. Employees
   can then see the published team roster and their own-shifts view, but never
   drafts. Reopening a published roster withdraws it from both employee views
   until a manager republishes it; communicate changes through the
   organization's approved channel.
7. If the original configuration is wrong, cancel the draft and create a
   corrected roster. Cancellation is versioned and audited, keeps the old
   roster and memberships as history, and releases its active employee/month
   reservations. A published roster must first be withdrawn to draft. A
   cancelled roster is not editable, publishable, or visible to employees.

Published rosters cannot be edited directly. Mutation requests require the
current `expectedVersion`; missing versions return `428`, and stale versions
return `409`. Scheduling actions are audited. No destructive roster endpoint
is provided.

Workforce transfers or deactivation do not automatically rewrite a published
roster. Generation, editing, and publication require active participants;
authorized withdrawal and draft cancellation can include inactive participants
so stale plans can be retired. Complete current scope is still mandatory. If a
transfer removes a participant from the manager's scope, an appropriately
authorized administrator must resolve the roster; do not expand the manager's
access merely to bypass that protection.

## Employee mobile-web workflow

An existing employee signs in normally, opens their shift page, and selects the
month. **Team schedule** is the default read-only view and returns the complete
published roster only when the caller is an active member and every participant
is still active in the same facility. It exposes teammate display names, shift
labels/times, and assignments only. It does not expose contact or organizational
profile fields, unavailable dates, planning constraints, coverage requirements,
versions, audit metadata, an editable draft, or any other facility's roster.
**My shifts** remains a separate personal view that returns only the caller's
published assignments. An empty month is not an error or a generated sample
roster.

For release acceptance, use a 390px viewport in Arabic/RTL and English/LTR.
Verify normal sign-in, dashboard, document list, authorized manual upload,
status inspection, authorized deletion, the team schedule, and the own-shifts
page. Also verify empty, loading, and failure states, keyboard access, that a
second facility cannot read the roster, and that reopening removes it from both
views on the next authorized fetch. Do not bypass authentication, intercept
browser requests, or introduce synthetic runtime data to obtain a passing
screenshot. A static render or unit test cannot establish this journey.

## Planning limits and adjacent months

- A roster covers one Gregorian calendar month in the supported 2000–2099
  range and one facility. It can contain 1–200 employees and 1–6 shift types.
- Coverage is the same configured headcount for each day of the month; it is
  not a per-day demand or skill-mix model. Required headcount is 0–200 for each
  shift type. A zero requirement does not certify that the facility is staffed.
- Times use the fixed `Asia/Riyadh` wall clock without daylight-saving changes.
  An end time earlier than the start means the next day. Equal times are
  rejected, and a shift must be longer than zero and no more than 16 hours.
  This is not a multi-time-zone or daylight-saving-aware scheduler.
- Rest is configurable in whole hours from 0–24. Maximum consecutive working days and
  maximum shifts in the month are configurable from 1–31. These bounds are
  input limits, not recommended or legally approved working conditions.
- The service checks adjacent saved rosters for boundary rest and consecutive
  days. It cannot account for unsaved schedules, work in another system,
  second jobs, on-call activity, or missing previous/next-month assignments.
  Review both month boundaries before publication and after changes to a
  neighboring month.
- There is no automatic email, text-message, calendar, regulator, or payroll
  dispatch. Existing provider opt-ins and fail-closed controls remain unchanged.

## Operator release gates

1. Review `lib/db/migrations/0010_thick_changeling.sql` and
   `lib/db/migrations/0011_futuristic_exiles.sql`, their snapshots, and the
   migration journal together. Migration 0010 creates
   `shift_schedules` and `shift_schedule_members`, including the unique
   employee/month membership key and foreign keys. Migration 0011 adds
   cancellation and replaces uniqueness with an active-membership partial
   index using `released_at`. Neither migration seeds employees or deletes
   roster rows.
   Use Node 24 and pnpm 11.19.0. Do not use schema `push`/`push-force` on shared
   data and do not reset or seed a production database.
2. Take an approved recoverable backup, then apply migrations with the separate
   migration identity before manually deploying the matching revision. The
   production image includes `/app/migrations`; the packaged `dist/migrate.mjs`
   entry point enforces the configured database-role boundary. The generic
   `pnpm db:migrate` development entry point does not run that wrapper.
3. Follow [the managed deployment runbook](RENDER_SUPABASE_DEPLOYMENT.md) for
   role provisioning, migration, secret injection, and manual deployment. Keep
   the existing API identity DML-only, the migration identity separate, and
   `VERIFY_DATABASE_ROLE_BOUNDARY=true`. The managed migration grants apply to
   all application tables and sequences; do not grant direct roster access to
   public/provider roles.
4. Validate the actual facility, department, supervisor, active-account, and
   role assignments. A manager's UI visibility is not authorization.
   Re-test authorization with two facilities and all five application roles,
   including transfer/deactivation and direct-ID requests.
5. Include both `shift_schedules` and `shift_schedule_members` in recovery
   acceptance. The encrypted backup command uses an unfiltered `pg_dump`, so
   there is no table allowlist to update; the backup identity must still be
   able to capture all rows. Prove roster configuration, assignments,
   membership, and version/status preservation in an isolated restore. Follow
   [the backup runbook](BACKUP_RESTORE.md) for keys, write freezes, retention,
   destination, and recovery isolation. No live backup is claimed here.
6. Approve roster retention, manager access, unavailability handling, audit
   access, and schedule-change communication. The existing document-storage,
   OCR, email, automation, MFA, monitoring, backup, and privacy release gates
   remain in force; scheduling does not waive them.

No scheduling-specific environment variable or third-party key is required.
The existing database, session/TOTP, origin, and production-role configuration
must be populated through the approved secret manager. Never work around a
failed production startup by disabling safeguards or enabling test login.

## Exact verification and viewing commands

Run from the repository root with the required runtimes. These are executable
checks, not a claim that they have all passed in a live environment:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck
pnpm run test
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/health-docs run build:production
git diff --check
```

For generated-client drift, compare the generated output before and after a
second codegen run. CI compares committed generated clients with regenerated
output and rejects modified or untracked generated files; an intentional new
contract naturally differs from the pre-feature revision.

Local test evidence recorded on 2026-09-01:

`pnpm run typecheck` and `pnpm run build:production` passed. A second OpenAPI
codegen run produced identical generated-file hashes. Prettier checks of the
new hand-written files and `git diff --check` passed. The production web build
still emitted its existing source-map/main-chunk warnings; those are not
evidence of deployed browser performance.

| Run                                                                   | Passed | Failed | Skipped | Meaning                                                                                                                                     |
| --------------------------------------------------------------------- | -----: | -----: | ------: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test`: operations                                           |     35 |      0 |       1 | The opt-in PostgreSQL backup drill skips in the default run.                                                                                |
| `pnpm --filter @workspace/health-docs run test` (latest frontend run) |    158 |      0 |       0 | Includes 61 scheduling state/static-render tests for manager, personal, and read-only team views; these are not browser interaction checks. |
| `pnpm run test`: API                                                  |    632 |      0 |       1 | The opt-in real-PostgreSQL authorization scenario skips in the default run.                                                                 |
| Focused scheduling API/logic run                                      |     44 |      0 |       0 | Route projection, published-team scope, personal minimization, authorization boundaries, conflicts, generation, and validation.             |
| Separate real PostgreSQL/HTTP authorization run                       |      1 |      0 |       0 | Disposable loopback database with real sessions, role/scope changes, published-team projection, and fail-closed roster checks.              |
| Separate encrypted PostgreSQL backup/restore drill                    |      1 |      0 |       0 | The recovery evidence below; it does not exercise deployed storage or browser login.                                                        |

The dedicated runs deliberately overlap tests from the default suite; do not
add their counts to claim unique test coverage. A skipped opt-in scenario is
not a pass. Authenticated 390px Arabic/English browser acceptance must be
recorded separately after actual interaction; static-render tests do not prove
layout, keyboard behavior, or the complete employee document journey.

The separately executed scheduling API commands were:

```powershell
pnpm --filter @workspace/api-server exec vitest run src/routes/schedules.test.ts src/lib/shiftScheduling.test.ts
$env:HCH_AUTH_POSTGRES_DRILL = 'true'
pnpm --filter @workspace/api-server exec vitest run src/routes/auth-isolation-postgres.test.ts
```

The integration scenario uses a new disposable loopback database, with the
existing local PostgreSQL tools under `.local/postgresql16-portable/pgsql/bin`
by default. An explicit `HCH_AUTH_DRILL_PG_BIN` may point to another approved
local binary directory. Its scheduling assertions cover the five roles,
two-facility isolation, complete-roster scope (including missing department or
supervisor values), personal and team published views, explicit response
projection, CAS conflicts, adjacent-month races, scope transfer, deactivation,
actor demotion, session revocation, and atomic audit rollback. The 44 focused
tests use controlled route/database boundaries; they are not additional live
database or browser sessions.

Authenticated scheduling browser acceptance was observed on 2026-09-01 in
Google Chrome against a disposable loopback PostgreSQL fixture. At 390x844,
real manager login with TOTP created a nine-person Arabic/RTL roster, retained
an unavailable date, exposed an intentional coverage deficit, blocked
publication while that deficit existed, saved corrected CAS versions, and
published version 4. The manager's personal view and a separate employee login
showed only the signed-in user's published assignments. Withdrawing the roster
created draft version 5; the employee's next authorized fetch returned the
empty unpublished state with no coworker names or manager controls. English/LTR
at 390px and the 1280x800 desktop grid had no document-level horizontal
overflow, and the browser error log was empty.

This is schedule-specific browser evidence using synthetic accounts and a
fixture database. It does not establish the complete employee document
journey, production migration, deployment, provider storage, or live-data
acceptance. No production or provider change was performed by this release
verification.

Follow-up team-roster browser acceptance was observed on 2026-09-01 against a
fresh disposable loopback PostgreSQL fixture. At 390x844, a real manager login
with TOTP generated and published a nine-person roster. A separate employee
login opened the read-only team view by default and showed all nine display
names and their published shifts, with the signed-in employee marked as the
current user. The same employee's personal view contained only that employee's
assignments. Neither view exposed contact details, employee numbers, planning
constraints, availability, coverage requirements, draft data, or manager
controls. Arabic/RTL and English/LTR both retained a 390px document width, and
the browser error log was empty after the final production-web rebuild.

The real PostgreSQL backup drill is opt-in and otherwise skips. Use an approved
local PostgreSQL binary directory, never a shared database URL:

```powershell
$env:HCH_BACKUP_DRILL_PG_BIN = 'C:\approved\postgresql\bin'
node --test scripts/operations/backup-postgres.test.mjs
```

Observed on 2026-08-31: the command above passed with **1 pass, 0 failures,
0 skips**, using the existing approved binaries at
`C:/Users/itzzk/Downloads/project-clean/.local/postgresql16-portable/pgsql/bin`.
The harness created and cleaned up its own new loopback cluster and did not
read `.env`. All 12 SQL migrations and 15 tables were restored; three scheduling
rows covered published, draft, and cancelled status, and three membership rows
included a released historical reservation alongside its active replacement.
Ordered row comparison preserved configuration, unavailable dates, assignments,
versions, status, and membership timestamps. A duplicate active membership was
rejected after restore. Two private-document fixtures also retained their bytes
and ACL metadata, and corruption/nonempty-target checks passed. The dump was
61,706 bytes. This is synthetic test-fixture recovery, not a provider backup or
authenticated browser acceptance.

After configuring an approved isolated environment, migrating it, and building
the application, the production startup command is `pnpm run start:production`
with `NODE_ENV=production`, `PORT`, and all required secrets already present in
the process environment. For a loopback instance configured on port 3000, open
`http://127.0.0.1:3000/`. This requires real approved accounts and backend
configuration; it is not an unauthenticated showcase command. Do not start the
production process against a shared environment merely to view this change.

Record the release SHA, exact check commands and pass/fail/skip counts,
migration evidence, operator, and authenticated narrow-screen acceptance in
the release ticket. Deployment and remote CI remain unverified until separately
authorized and observed.
