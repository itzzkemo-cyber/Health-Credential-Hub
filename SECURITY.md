# Security policy

Do not open a public issue for a suspected vulnerability or exposed secret. Report it privately through GitHub Security Advisories for this repository and include affected routes, roles, reproduction steps, and impact. Do not include real employee data or credential documents.

Supported code is the latest commit on `main`. Security fixes should include tenant-isolation and authorization regression coverage when a test harness is available.

Operational requirements include administrator-provisioned accounts, a strong managed `SESSION_SECRET`, private object storage, reviewed database migrations, approved OCR data processing, and secret rotation after any exposure. Public registration and test-only authentication are not part of the release.

Every direct account-provisioning operation and role/scope change requires an
administrator password step-up. The immutable account selected by
`PROTECTED_MFA_USER_ID` must additionally provide a current TOTP or backup code
and cannot disable its own MFA; other accounts are not enrolled or challenged
for TOTP. Invitation onboarding remains the default account-creation path. This
single-account MFA policy is an explicit owner risk decision and is weaker than
requiring MFA for every privileged account. The protected account MFA must be
enabled before real workforce data is introduced. The encrypted
Windows filesystem profile is a controlled single-host acceptance path, not a
high-availability healthcare production claim. GCS and OCI direct uploads must
remain synthetic-only until bounded provider ingress, malware quarantine,
auditable orphan cleanup, and restore testing are approved.
