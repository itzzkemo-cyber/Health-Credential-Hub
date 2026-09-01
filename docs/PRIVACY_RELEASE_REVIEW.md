# Privacy and operational release review — 2026-08-31

This is an engineering review and decision register, **not legal advice, a
published privacy notice, or a certification of Saudi PDPL compliance**. The
controller must approve the actual processing before real workforce documents
are collected. Do not invent a company, legal basis, retention period or owner.

## Current evidence

| Control | Observed evidence | Limitation / required action |
| --- | --- | --- |
| Storage privacy | After explicit owner approval, added PDF to the existing JPEG/PNG allowlist and reopened saved Supabase settings: Public bucket OFF, file limit ON at 8 MB, MIME restriction ON. No access policies changed. | S3 keys bypass Storage RLS. This is a settings review, not proof of least-privilege key issuance or a live cross-tenant document test. |
| Data location | Supabase dashboard showed AWS Frankfurt (`eu-central-1`); checked-in Render profile also targets Frankfurt. | Document the actual storage, compute, logs, backups and support-access locations. Approve any cross-border transfer position; do not infer Saudi residency from the Arabic domain/name. |
| Backups | Local encrypted archive/restore tests passed with a new PostgreSQL cluster and synthetic documents. Supabase dashboard showed no last backup. | A live capture, independent encrypted destination/key escrow, schedule, retention and a real-provider recovery drill are not yet configured or proven. Database-only backups do not include Storage object bytes. |
| Administration | 115 added HTTP route tests plus an opt-in real PostgreSQL + HTTP + private filesystem drill cover password/TOTP login, admin delegation with consumed step-up code, replay denial, scope, file denial, session revocation and persisted audit. On August 31 the owner's live Chrome session loaded the dashboard/directory as System Admin; Settings/profile reported 2FA enabled and an active account. | The live check was read-only: role options and step-up form inspected without submission. Delegation/revocation and cross-facility file denial remain synthetic-drill evidence, not live acceptance. The directory contained only the owner account and its document list was empty. |
| Document processing | Image/PDF reconstruction is server-side with no new external processor; originals are not retained by the upload path. | Rasterization changes PDFs. Disclose loss of selectable text, reject signatures/forms, retain issuer originals outside this service as appropriate. Process isolation is not an OS sandbox or antivirus guarantee. |
| External processors | Live readiness reported email configured and OCR disabled; n8n is opt-in in code. SMS OTP support is implemented against Twilio Verify but is not evidence that a Verify account, Saudi sender or production credentials are approved or enabled. | Verify Resend and Twilio contracts, sender setup, data retention, tracking, region/subprocessors, transfer safeguards and deletion terms. No OCR/n8n enablement is authorized by this review. |
| Availability | After successful GitHub CI/Linux image checks, Render reported deployment `dep-daac2oon74is73afbagg` Live. Readiness returned `ready` for exact release `ff78416265a4b9118bbea4647a59c40b1eefc653`, and the live authenticated form accepted PDF. UptimeRobot monitor `803870616` previously reported Up; DOWN/UP test emails were confirmed in the operations inbox at 23:07 UTC on August 30. | PDF storage round-trip and live cross-facility denial remain separate acceptance gates. A test notification is not an outage simulation or future delivery guarantee. Render Free is not a production availability guarantee. |

## Required owner decisions

Before approving production, record an accountable owner and evidence for each:

1. **Controller and notice:** accurate legal/person identity and contact, purpose,
   categories of data, recipients, rights/request channel, notice version and
   where employees see it before providing data. The current login page is not
   an adequate published privacy notice by itself.
2. **Legal basis and minimization:** review the employment/credential purpose;
   avoid collecting medical histories or unrelated identifiers. Do not assume
   consent is the appropriate basis for every employee workflow.
3. **Retention/deletion:** separately approve employee profiles, original issuer
   documents held elsewhere, stored reconstructed documents, grants, audit
   records, email logs, unclaimed objects and backups. Soft deletion preserves
   audit history; it does not satisfy every deletion request automatically.
4. **Providers and transfers:** review processor contracts/DPA, subprocessors,
   data region, support access, transfer safeguards and breach terms for
   Render, Supabase, Resend, Twilio Verify and any later OCR or workflow
   recipient.
5. **Security operations:** MFA for privileged accounts, named backup/key
   custodian and independent recovery reviewer, incident escalation/notification
   procedure, alert delivery tests, secret rotation and least-privilege reviews.
6. **Availability and recovery:** approve RPO/RTO, restore isolation, write-freeze
   window, encrypted off-provider destination and budget. Monitoring cannot
   substitute for backups or a suitable hosting plan.

Use only synthetic data for acceptance until these decisions are complete.
Do not send employee files or database archives in support tickets or chat.

## Primary references reviewed

- [Supabase bucket privacy](https://supabase.com/docs/guides/storage/buckets/fundamentals): private and public access have different authorization behavior.
- [Supabase backups](https://supabase.com/docs/guides/platform/backups): database backup and Storage file backup are separate responsibilities.
- [Supabase DPA](https://supabase.com/downloads/docs/Supabase%2BDPA%2B250805.pdf): review the agreement applicable to the operator's account; a link is not acceptance.
- [Render Free services](https://render.com/docs/free): review sleep, suspension and production-use limitations.
- [SDAIA regulations and policies](https://sdaia.gov.sa/en/SDAIA/about/Pages/RegulationsAndPolicies.aspx) and [personal data transfer regulation](https://sdaia.gov.sa/en/SDAIA/about/ArchivesRegulationsAndPolicies/RegulationonPersonalDataTransferoutsideKingdomEN.pdf): use the current applicable text with a qualified privacy reviewer.

Related runbooks: [backup/restore](BACKUP_RESTORE.md),
[PDF security](PDF_UPLOAD_SECURITY.md), [monitoring](MONITORING_AND_STORAGE.md),
and [integrations](INTEGRATIONS.md).
