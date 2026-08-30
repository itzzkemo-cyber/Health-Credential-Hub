# Verification record — 2026-08-31

## Implemented and checked locally

- Bounded private PDF reconstruction, Arabic/English upload notices, verified
  stored-type propagation, OpenAPI/generated clients, and Linux image self-test
  gate. PDF OCR remains disabled; no external document processor added.
- AES-256-GCM database/document backup implementation preserving checksums and
  private ACL metadata. Full isolated PostgreSQL restore drill, corrupt-archive
  rejection and nonempty-target refusal passed. No live backup is claimed.
- 115 additional mocked HTTP authorization cases and a separate real
  PostgreSQL/HTTP/private-filesystem login, MFA, delegation and isolation drill.
- Ignored backup/security outputs and excluded `.local` trees from Docker build
  contexts. Added real operations tests, PostgreSQL drills and Docker checks
  to CI; no invented lint command.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm run typecheck` | Passed |
| `pnpm run test`, with both isolated PostgreSQL drills enabled | 722 passed: 589 API, 97 frontend, 36 operations; zero skipped |
| `pnpm run build:production` | Passed; existing Vite sourcemap and >500 kB chunk warnings remain |
| `node artifacts/api-server/dist/check-pdf-security.mjs` | Passed on Windows with production child-process flags |
| OpenAPI codegen repeated twice | Identical generated file hashes |
| `pnpm audit --prod --audit-level=high` | No known vulnerabilities reported at check time; not a security guarantee |
| `git diff --check` and scoped staged secret/path pattern screen | Passed; no sensitive build/backup paths staged |
| Linux Docker runtime | Not locally runnable: Docker/WSL unavailable. Required CI image build includes PDF child self-test |

### Remote CI follow-up

- Published the reviewed implementation as `84abec8`; the first Linux run
  passed install, codegen, typecheck and tests, then failed starting the
  disposable PostgreSQL cluster. The drills now disable Unix-domain sockets
  on non-Windows hosts and use their existing loopback TCP clients, avoiding
  reliance on a runner's system socket directory. Windows behavior is unchanged.
- Commit `ff78416265a4b9118bbea4647a59c40b1eefc653` passed
  [GitHub CI run 33342613206](https://github.com/wathaiqihealth/Health-Credential-Hub/actions/runs/33342613206)
  on August 31. Both real PostgreSQL drills, API/web builds and the final Linux
  Docker image check passed. The runtime-user PDF security self-test passed
  inside that image; no production documents or secrets were used in CI.
- The owner approved this exact repository's `main` branch and deployment
  after CI. Render was instructed to deploy the tested `ff78416` commit, not
  an unverified branch tip. Live readiness is checked separately below.

Commands that failed under Windows filesystem/process sandboxing were rerun
with explicit scoped execution approval; no test assertion or security control
was weakened. Test databases, files and identities were synthetic and isolated.
Their clusters were stopped and only their newly created fixture directories
were removed; production data was not deleted.

## External controls verified

- Supabase private bucket: saved allowlist JPEG/PNG/PDF after explicit owner
  approval; reopened settings confirmed Public OFF, limit 8 MB and MIME
  restriction ON. No access policies were changed.
- UptimeRobot monitor `803870616` (**Wathaiqi Health - Readiness**) created on
  the free plan, five-minute checks, readiness URL only, approved business-email
  alerts, no public status page, no SMS/purchase. Observed **Up**.
- Built-in test notification requested without service interruption; both DOWN
  and UP test messages confirmed in the operations inbox at 23:07:06/08 UTC
  on August 30 (02:07 Riyadh on August 31).
- Live application was still release
  `6358d773573b18559286b189a48843292e32426c`, with readiness HTTP 200. This does
  **not** prove the PDF code in this working tree was deployed.

## Owner-session acceptance — August 31, approximately 02:33–02:40 Riyadh

- After the owner signed in through Chrome, the live dashboard and employee
  directory loaded successfully with the **System Admin** role. The own-profile
  page reported an active account; Settings and the profile reported **2FA
  enabled**. No password, TOTP code, backup code or browser session store was read.
- Opened (without submitting) the direct account-creation form. The role list
  offered hospital admin, department manager, supervisor and employee; facility
  selection and password/MFA step-up fields were present. No account or
  invitation was created, no password generated and no permission changed.
- Inspected the employee directory at 390 x 844 in Arabic/RTL and English/LTR.
  Both rendered the mobile card layout with document width equal to viewport
  width (390 px), with no horizontal overflow. Restored Arabic and the normal
  viewport after inspection. This is an **admin-directory** check, not the full
  employee sign-in/upload journey.
- The directory contained only the owner account; the own-profile document
  list was empty. No real document download or live two-facility denial could be
  tested from this session. Existing isolated authorization/drill results remain
  separate evidence, not a claim of live delegation or file-isolation acceptance.
- Public readiness was rechecked: `ready`, database `ok`, object storage
  `verified`, uploads `enabled`, email `configured`, OCR `disabled`. The release
  SHA remained `6358d773573b18559286b189a48843292e32426c`.

## Deployment outcome — August 31, approximately 02:51 Riyadh

- Render deployment `dep-daac2oon74is73afbagg` reported **Deploy succeeded / Live**
  for `ff78416265a4b9118bbea4647a59c40b1eefc653` (1m45s). The public `/api/readyz`
  response subsequently reported **ready** with that exact SHA, database `ok`,
  object storage `verified`, uploads `enabled`, email `configured`, OCR `disabled`.
- Reloading the owner's Chrome tab retained the authenticated System Admin
  session and successfully loaded the employee directory after deployment.
- The live own-profile upload form displayed JPEG/PNG/PDF with 8 MiB and five
  PDF pages. Its file input accepted `image/jpeg,image/png,application/pdf`.
  No personal file was selected or submitted; the document-specific upload
  confirmation is still pending. This confirms the deployed form, not storage
  round-trip acceptance.
- Render's build log warned its linked repository credentials did not have
  access, then successfully cloned the approved public repository. Review the
  GitHub app/repository connection before making the repository private; no
  additional GitHub app permissions were granted during this release.
- No personal document, identity number, password, archive or provider secret
  was committed to GitHub. Owner-file selection/inspection remained local;
  live document submission is a separate, explicitly approved operation.

## Unfinished production gates

1. Repository approval, publication, remote CI/Linux checks, Render deployment
   and matching live readiness SHA are now complete as recorded above.
2. Complete approved PDF upload/link/download acceptance and cross-tenant
   denial on Render/Supabase. Readiness and the Linux self-test are not a
   substitute for end-to-end private-document acceptance.
3. Provision the dedicated backup runner identity, independent encrypted
   destination and key escrow, approve a real write-freeze window, then take a
   live backup, restore it in an approved isolated environment, and activate
   schedule/age/failure monitoring. The local drill is not this production backup.
4. Owner sign-in and reported active administrator/2FA state are now verified
   as described above. Live delegation/revocation, employee acceptance and
   cross-facility file denial remain unverified; no production test identities
   or documents were created during this read-only check.
5. Complete the named-owner privacy/retention/provider/transfer and availability
   decisions in [PRIVACY_RELEASE_REVIEW.md](PRIVACY_RELEASE_REVIEW.md). No legal
   approval, paid availability guarantee or completed Strix scan is claimed.
