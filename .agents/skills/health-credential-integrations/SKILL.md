---
name: health-credential-integrations
description: Design or review Health Credential Hub integrations with Gemini OCR, private object storage, email, Google OAuth, and future FHIR, HL7, SMART, or regulator APIs. Use when data crosses a service boundary.
---

# Health Credential Integrations

1. Map data sent, destination, region, purpose, retention, credentials, timeout, retry/idempotency, quotas, and failure behavior before coding.
2. Assume credential files contain sensitive workforce PII and may incidentally contain health data. Send the minimum data and never log bodies, tokens, Base64, or presigned URLs.
3. Keep providers optional and lazily initialized. Feature flags must fail closed in production.
4. For storage, require private ACLs, scoped reads, strict type/size checks, orphan cleanup, and a malware-scanning plan.
5. For OAuth, link verified existing accounts safely and require explicit production approval for auto-provisioning.
6. For FHIR/HL7/SMART work, confirm the exact profile/version, terminology, patient-vs-workforce boundary, consent, and conformance tests; do not label a custom API as standards-compliant.
