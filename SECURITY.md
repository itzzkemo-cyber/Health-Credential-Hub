# Security policy

Do not open a public issue for a suspected vulnerability or exposed secret. Report it privately through GitHub Security Advisories for this repository and include affected routes, roles, reproduction steps, and impact. Do not include real employee data or credential documents.

Supported code is the latest commit on `main`. Security fixes should include tenant-isolation and authorization regression coverage when a test harness is available.

Operational requirements include administrator-provisioned accounts, a strong managed `SESSION_SECRET`, private object storage, reviewed database migrations, approved OCR data processing, and secret rotation after any exposure. Public registration and test-only authentication are not part of the release.
