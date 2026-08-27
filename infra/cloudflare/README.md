# Cloudflare Tunnel launch path (Windows)

This package publishes the existing production application at
`https://app.wathaiqihealth.com` through one **named**, locally managed
Cloudflare Tunnel. The origin remains `http://127.0.0.1:3000`; no inbound router
port is opened. The package does not create a tunnel, change DNS, install a
service, or copy credentials by itself.

Cloudflare's Free plan and Tunnel can provide a no-payment delivery path, but
they do not turn a Windows PC into managed healthcare hosting. The PC, internet
connection, application process, PostgreSQL, private object storage, and
`cloudflared` service must all remain healthy and powered on. A single PC has no
high availability, managed disaster recovery, or guaranteed uptime. Do not put
real workforce or health-related documents through this path until the
production gates below are approved.

There is no Demo login, public registration, request interception, synthetic
runtime data, or bypass in this package. The application and `/api/readyz` must
fail closed when its production database or private storage is unavailable.

## Trust boundary and data flow

The browser negotiates HTTPS with Cloudflare's edge, so Cloudflare can process
request metadata and application content before forwarding it through the
outbound encrypted Tunnel connection to `cloudflared` on Windows. `cloudflared`
then sends plain HTTP over loopback only to Express. The purpose is public web
delivery without an inbound port; it is not a storage or backup integration.

This path can carry employee identity data and credential documents. Before real
data, the operator must approve Cloudflare's contract/privacy terms, processing
locations, subprocessors, breach process, and retention for the selected plan.
The Free path does not establish Saudi-only processing or a healthcare privacy
agreement. Do not add Cloudflare Workers, request-body logging, Browser Insights,
third-party analytics, or inspection products without a new data-flow review.
Keep caching bypassed for `app.wathaiqihealth.com/*`, and never cache API,
authenticated, upload, or document responses.

The named-tunnel JSON is the only runtime Cloudflare credential. It authorizes
this tunnel connector and does not belong in application environment variables.
The account-wide `cert.pem` is used only by an administrator for tunnel/DNS
management. Protect the Cloudflare administrator with phishing-resistant MFA,
least-privilege roles, change alerts, and a separate recovery account. The
origin connect timeout is ten seconds; unavailable database/storage keeps
`/api/readyz` failed, and the public verifier blocks release rather than falling
back to alternate or synthetic data.

## 1. Release gates before any DNS change

1. Build and run the application in production mode with all secrets outside
   Git. At minimum, set `NODE_ENV=production`, `PORT=3000`,
   `PUBLIC_APP_URL=https://app.wathaiqihealth.com`, and
   `APP_ORIGINS=https://app.wathaiqihealth.com`, plus the reviewed database,
   session/TOTP, and private-storage variables documented by the project.
2. Bind the application **only** to `127.0.0.1`. `preflight.ps1` refuses a
   wildcard (`0.0.0.0`/`::`) or LAN listener.
3. Confirm `http://127.0.0.1:3000/api/readyz` returns `200` and reports the
   database and private object-storage boundary ready. Do not substitute
   `/api/healthz`; it checks only that the process is alive.
4. Finish encrypted, off-device backups and a tested restore for PostgreSQL and
   private objects. Configure disk encryption, Windows patching, endpoint
   protection, restricted local administrators, UPS/restart behavior, and
   security-log retention without document bodies, presigned URLs, tokens, or
   OCR payloads.
5. Keep email, OCR, and automation disabled until their privacy terms, region,
   retention, credentials, allowlists, and failure runbooks are approved.

## 2. Protect the existing domain and email

Before replacing registrar nameservers, export the current DNS zone and compare
every record with Cloudflare's import. Preserve the Google Workspace MX records,
the single SPF TXT record containing `include:_spf.google.com`, Google DKIM at
`google._domainkey`, DMARC at `_dmarc`, verification TXT records, and any
Squarespace records still required. Mail-related records must remain DNS-only;
never proxy MX or mail hostnames.

If DNSSEC is enabled at the registrar, disable the old DS record **before** the
nameserver change. Wait for its removal, change only the two authoritative
nameservers to the pair assigned by Cloudflare, verify the zone becomes Active,
then enable Cloudflare DNSSEC and publish Cloudflare's new DS values. A stale DS
record can make the whole domain, including email, fail DNS validation. Keep the
exported zone and original nameservers for rollback.

Do not continue if the imported records differ or if Google Workspace mail is
not working. Relevant operator references:

- [Cloudflare full DNS setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
- [Cloudflare DNSSEC setup](https://developers.cloudflare.com/dns/dnssec/)
- [Google Workspace MX records](https://support.google.com/a/answer/174125)

## 3. Create the named tunnel

Install `cloudflared` from Cloudflare's signed package or with `winget`, then run
these commands in a normal PowerShell session. Browser login and the DNS route
are intentional account changes; review the selected Cloudflare account and
zone before approving them.

```powershell
cloudflared --version
cloudflared tunnel login
cloudflared tunnel create wathaiqi-health
cloudflared tunnel list
cloudflared tunnel route dns wathaiqi-health app.wathaiqihealth.com
```

`tunnel login` creates `cert.pem`, which can manage tunnels across the account.
Keep it only in the administrator's profile and never copy it into the service
directory. `tunnel create` writes `<TUNNEL-UUID>.json`; that credential can run
only this tunnel, but it is still a secret.

Cloudflare references for this step:

- [Create a locally managed named tunnel](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/)
- [Account certificate versus tunnel credential permissions](https://developers.cloudflare.com/tunnel/advanced/local-management/tunnel-permissions/)

In the Cloudflare dashboard, enable **Always Use HTTPS** for the hostname and
create an explicit Cache Rule that bypasses cache for
`app.wathaiqihealth.com/*`. Leave Always Online disabled for this hostname so a
stale authenticated or health-related response is never served when the origin
is unavailable. Do not enable a Worker, transform rule, request-body logging, or
an origin override. The public verifier below blocks the release if HTTP still
does not redirect to the canonical HTTPS origin.

Prepare the service directory from an **elevated** PowerShell window. Replace
`<TUNNEL-UUID>` with the value printed by `tunnel create`. Never paste or echo
the JSON contents.

```powershell
$serviceDir = "C:\ProgramData\WathaiqiHealth\cloudflared"
New-Item -ItemType Directory -Path $serviceDir -Force
# Grant LocalSystem and Administrators before removing inherited access so the
# credential is never copied into a broadly readable directory.
icacls $serviceDir /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls $serviceDir /inheritance:r

Copy-Item .\infra\cloudflare\config.example.yml "$serviceDir\config.yml"
Copy-Item "$env:USERPROFILE\.cloudflared\<TUNNEL-UUID>.json" $serviceDir
notepad "$serviceDir\config.yml"
```

Edit only the two UUID placeholders in `config.yml`. The file must keep one
hostname rule, the loopback origin, loopback metrics, non-debug logging, and the
final `http_status:404` catch-all. Do not add a token, `cert.pem`,
`credentials-contents`, `noTLSVerify`, a LAN origin, or another hostname.

Run the fail-closed check from an elevated PowerShell window:

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\infra\cloudflare\preflight.ps1 `
  -ConfigPath "C:\ProgramData\WathaiqiHealth\cloudflared\config.yml"
```

It validates the config and credential ACLs without reading or printing the
credential, uses Cloudflare's parser, rejects a non-loopback origin, calls the
real local `/api/readyz`, confirms Cloudflare nameservers, and checks Google
Workspace MX/SPF/DKIM/DMARC. It changes nothing.

For the first connection, run in the foreground and stop with `Ctrl+C` after the
public verification succeeds:

```powershell
cloudflared --config "C:\ProgramData\WathaiqiHealth\cloudflared\config.yml" tunnel run
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\infra\cloudflare\verify-public.ps1
```

The public verifier performs only non-mutating probes. It requires HTTP-to-HTTPS
redirection, production readiness, the sign-in page, and 404 responses to safe
`POST {}` probes for both public registration and Demo login. It also checks
HSTS, CSP anti-framing, `nosniff`, and `DENY` framing headers. It never logs in or
creates data.

## 4. Install at boot

After foreground verification, follow Cloudflare's current
[Windows service guide](https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/windows/).
Use a stable executable path such as `C:\Cloudflared\bin\cloudflared.exe`; do not
point the service at a temporary WinGet package directory. Install from an
elevated PowerShell prompt. Restrict the stable directory before copying the
binary because the service runs as LocalSystem; a non-administrator must never
be able to replace that executable. Replace `<SIGNED-CLOUDFLARED.EXE>` with the
reviewed download or installed package path. These commands verify both the
Cloudflare signer and the copied file before registering anything:

```powershell
$source = "<SIGNED-CLOUDFLARED.EXE>"
$destinationRoot = "C:\Cloudflared\bin"
$destination = Join-Path $destinationRoot "cloudflared.exe"

$sourceSignature = Get-AuthenticodeSignature -LiteralPath $source
if ($sourceSignature.Status -ne "Valid" -or
    $sourceSignature.SignerCertificate.Subject -notmatch 'O="?Cloudflare, Inc\.') {
  throw "The source cloudflared executable is not signed by Cloudflare, Inc."
}

New-Item -ItemType Directory -Path $destinationRoot -Force
icacls "C:\Cloudflared" /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
icacls "C:\Cloudflared" /inheritance:r
Copy-Item -LiteralPath $source -Destination $destination -Force

$installedSignature = Get-AuthenticodeSignature -LiteralPath $destination
if ($installedSignature.Status -ne "Valid" -or
    $installedSignature.SignerCertificate.Subject -notmatch 'O="?Cloudflare, Inc\.') {
  throw "The installed cloudflared executable is not signed by Cloudflare, Inc."
}
& $destination --version
& $destination service install
```

The install command must not contain a tunnel token. Set the `cloudflared`
service `ImagePath` to the locally managed config path instead. The registry
value contains paths only; the tunnel credential stays in the ACL-restricted
JSON referenced by `config.yml`:

```powershell
$imagePath = '"C:\Cloudflared\bin\cloudflared.exe" --config="C:\ProgramData\WathaiqiHealth\cloudflared\config.yml" tunnel run'
Stop-Service -Name cloudflared -ErrorAction SilentlyContinue
Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\cloudflared" `
  -Name ImagePath -Value $imagePath
sc.exe config cloudflared start= delayed-auto
sc.exe failure cloudflared reset= 86400 actions= restart/5000/restart/30000/restart/60000
sc.exe failureflag cloudflared 1
Start-Service -Name cloudflared
Get-CimInstance Win32_Service -Filter "Name='cloudflared'" |
  Select-Object Name, State, StartMode, StartName, PathName
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\infra\cloudflare\verify-public.ps1
```

Confirm that `PathName` contains only the stable executable, config path, and
`tunnel run`; it must not contain a token or inline credential. Configure the
production application, PostgreSQL, and storage processes to start before
`cloudflared`, and alert when `/api/readyz` or the tunnel connector goes down.
`cloudflared` starting at boot does not start the application or database.
Do not schedule the current interactive operator's `Start-Production.ps1`: its
DPAPI bundle is user-bound and the script is not a long-running service
supervisor. Automatic application startup first needs a dedicated Windows
service identity, secrets re-created under that identity, a reviewed
long-running wrapper/recovery policy, and tested PostgreSQL -> application ->
tunnel ordering. Keep foreground startup until that separate change is
implemented and verified.
Update the stable executable under an approved maintenance window, restart the
service, rerun both checks, and retain the previous signed executable for quick
rollback. Never use debug logging in production because request headers can
contain authentication or sensitive metadata.

## 5. Rollback and uninstall

For an application rollback, stop the tunnel service first, restore the last
reviewed application/database version, run local readiness and `preflight.ps1`,
then start the tunnel and rerun `verify-public.ps1`.

For an immediate public shutdown:

```powershell
sc.exe stop cloudflared
```

If the connector must be removed, uninstall it from an elevated prompt:

```powershell
C:\Cloudflared\bin\cloudflared.exe service uninstall
```

Uninstalling the Windows service does not remove the Cloudflare DNS route or
tunnel. After confirming the site must remain offline, remove the
`app.wathaiqihealth.com` tunnel route in Cloudflare, then delete the tunnel from
the authenticated administrator profile. Do not delete a tunnel while another
connector still depends on it.

For a nameserver rollback, restore the original registrar nameservers and the
matching original DNSSEC state from the recorded change plan. DNS propagation is
not instantaneous; monitor website and Google Workspace mail throughout. Keep
the Cloudflare zone until rollback is confirmed. Securely remove the service
credential and config only after the tunnel and rollback evidence are complete;
do not delete `cert.pem` unless all account-level CLI management has been moved
and tested.

## Remaining production blockers

Cloudflare Tunnel protects transport and avoids opening an inbound port. It does
not provide managed compute, a managed database, private object-storage
durability, endpoint security, backups, incident response, health-data privacy
agreements, Saudi data-residency assurance for every Cloudflare feature, or high
availability. Those are release gates before real employee documents. Until
they are approved and independently tested, this topology is an operator-hosted
acceptance path, not a claim of production-grade healthcare hosting.
