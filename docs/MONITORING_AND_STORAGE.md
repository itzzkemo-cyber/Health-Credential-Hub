# Storage preflight and outage monitoring

## Read-only Supabase preflight

The optional one-shot command below reads **bucket settings only**. It does
not list employee objects, download documents, issue keys or alter policies.

```text
node scripts/check-supabase-storage.mjs
```

Provide `SUPABASE_PROJECT_URL`, `PRIVATE_OBJECT_DIR`, and an approved temporary
server-only `SUPABASE_STORAGE_AUDIT_TOKEN` out of band. If the bearer token is
not an API key, also supply `SUPABASE_STORAGE_AUDIT_API_KEY`. Use
`STORAGE_AUDIT_REQUIRE_PDF=true` for this release. Never copy those secrets into
Git, UI code, chat or public CI. Remove the temporary environment afterward.

Success requires the exact bucket identity, `public=false`, exactly 8388608
bytes maximum, and a bounded MIME allowlist (JPEG/PNG/PDF, with JPEG required;
PDF required when its gate is on). The command rejects redirects and arbitrary
hosts, outputs only boolean checks and a timestamp, and returns nonzero on
failure. It cannot prove object ACLs, RLS-bypassing key privileges, region,
retention or backup. The dashboard is a read-only alternative when an approved
audit identity is not available; do not create a broad key just to run a test.

When enabling PDF, add `application/pdf` without changing public access or
anonymous/authenticated policies. Run the Linux image's built-in PDF check and
the authenticated upload/link/read/cross-tenant-denial tests before release.

## UptimeRobot

Inspect the account for an existing matching monitor before creating another.
Use `https://app.wathaiqihealth.com/api/readyz` and a five-minute free-plan
interval. The configured monitor uses the provider's default HTTP method and
success-code policy (2xx/3xx); custom HTTP methods and exact success codes were
marked paid features. Redirect following is OFF. Independently require HTTP
200 in release verification. Alert on failure and recovery to the
approved operations mailbox. Keep the monitor private; include no credentials,
cookies, employee identifiers, document URLs or response body in it.

The helper supports the provider's official no-key email-activation flow:

```text
node scripts/request-uptimerobot-monitor.mjs
```

Set `UPTIMEROBOT_OWNER_EMAIL` to the approved operations mailbox. The helper
solves the provider-issued challenge with a bounded deadline and requests only
the fixed readiness URL. **HTTP 200 does not prove monitor creation or email
delivery**: the provider intentionally uses uniform responses. Complete the
email activation, inspect the monitor and recipients in the dashboard, and
record a real test notification. Do not mark this control active from helper
output alone. On 2026-08-31 the helper API returned HTTP 503. After explicit
owner approval for Google identity sharing, dashboard setup succeeded instead:
monitor `803870616`, **Wathaiqi Health - Readiness**, reported **Up**, first
observed response 227 ms, every five minutes, and an approved business-email
recipient selected. It is attached to no public status page. Delay/repeat are
OFF; SMS, paid options and marketing subscriptions were not enabled. The
built-in notification test was run without interrupting the service. Gmail
confirmed both **TEST: Monitor is DOWN** and **TEST: Monitor is UP** in the
approved operations inbox at 2026-08-30 23:07:06/08 UTC (2026-08-31 02:07 in
Riyadh). This proves that test-email delivery path at that time, not an actual
production outage or future delivery guarantee.

Prefer a built-in test notification. Do not intentionally interrupt the live
service merely to test an alert; any outage/recovery simulation needs an
approved isolated target or maintenance window. Record monitor ID, owner,
recipient, interval, expected status, last test/delivery time and escalation
contact without including authentication material.

A five-minute HTTP check is not an SLA, security scan or end-to-end employee
transaction test. It does not remove Render Free limits or replace backup
monitoring. Add separate alerts for backup age/failure, storage/DB quota,
restarts, mail failures and security incidents through approved channels.

References: [UptimeRobot official quick monitor setup](https://uptimerobot.com/quick-monitor-setup/),
[API documentation](https://uptimerobot.com/api/),
[Render Free limitations](https://render.com/docs/free).
