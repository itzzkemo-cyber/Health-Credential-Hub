---
name: health-credential-security
description: Threat-model or review Health Credential Hub changes for tenant isolation, authentication, authorization, file access, OCR/privacy, secrets, audit integrity, destructive operations, CSV/export safety, and supply-chain risk. Use before production or for security-sensitive changes.
---

# Health Credential Security

1. Read `AGENTS.md` and trace trust boundaries from route to database/object store/provider; UI hiding never counts as access control.
2. Test every sensitive action as employee, supervisor, department manager, hospital admin, and system admin across at least two facilities.
3. Look for IDOR, cross-tenant reads, self-promotion, self-verification, fail-open flags, session reuse, unsafe seed/delete behavior, and unbounded paid-provider calls.
4. Verify JWT constraints, strong production secrets, cookie/CSRF/CORS behavior, sensitive-log redaction, reset-token handling, and browser session storage boundaries.
5. Verify upload provenance, ACL ownership transitions, file type/size enforcement, content hardening, retention, and orphan/malware controls.
6. Report findings by severity with file/route evidence, exploit conditions, and the smallest safe remediation. Distinguish code fixes from operator/compliance requirements.
