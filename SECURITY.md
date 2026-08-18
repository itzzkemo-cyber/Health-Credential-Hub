# Security policy

Do not open a public issue for a suspected vulnerability or exposed secret. Report it privately through GitHub Security Advisories for this repository and include affected routes, roles, reproduction steps, and impact. Do not include real employee data or credential documents.

Supported code is the latest commit on `main`. Security fixes should include tenant-isolation and authorization regression coverage when a test harness is available.

Operational requirements include production-disabled Demo and self-registration defaults, a strong managed `SESSION_SECRET`, private object storage, reviewed database migrations, approved OCR data processing, and secret rotation after any exposure.

## Known toolchain advisory

As of 2026-08-18, npm reports two high-severity denial-of-service advisories for Metro's transitive `image-size@1.2.1`. The advisory names `2.0.3` as patched, but npm does not publish that version yet. Exposure is limited to the Expo build toolchain parsing local assets, not request handling in the deployed API. Upgrade Expo/Metro immediately when a compatible patched version is released.
