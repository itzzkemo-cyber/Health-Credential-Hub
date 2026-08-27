# Cloudflare Worker acceptance bridge

This Worker provides a stable, no-payment `workers.dev` acceptance URL while
the authoritative nameservers for `wathaiqihealth.com` are still outside
Cloudflare. It proxies requests through a Workers VPC service bound to the
named Cloudflare Tunnel; it does not expose an inbound port on the Windows
host.

Current acceptance URL:

`https://wathaiqi-health-bridge.worker-bridge.workers.dev`

Workers VPC is currently beta and `workers.dev` is not the final production
hostname. Keep the named tunnel running, do not process real employee documents
until the production operations/privacy gates are complete, and switch the
application back to `https://app.wathaiqihealth.com` after the Cloudflare zone
becomes active.

The bridge intentionally contains no request logging. Never add logs for
headers, cookies, request bodies, upload bodies, OCR content, or responses.

Deploy from this directory with an account-scoped Wrangler login that has only
`user:read`, `account:read`, `workers_scripts:write`, and
`connectivity:admin`:

```powershell
pnpm dlx wrangler@latest deploy
```

After deployment, set the API runtime `PUBLIC_APP_URL` and `APP_ORIGINS` to the
exact `https://<worker>.<account>.workers.dev` origin, restart the API, then
verify login, CSRF, readiness, uploads, downloads, account-state operations,
security headers, and the 390px Arabic/English layouts.
