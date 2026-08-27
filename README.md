# وثائقي الصحية | Watha'iqi Health

منصة عربية/إنجليزية لإدارة وثائق واعتمادات الكوادر الصحية، مع موقع متجاوب، API آمن، تخزين ملفات خاص، قراءة OCR اختيارية، تنبيهات، وتقارير امتثال.

> **هدف الإصدار الحالي:** الموقع المتجاوب هو واجهة المنتج الوحيدة التي تُنشر. يستطيع الموظف من الجوال إدخال بياناته ورفع صورة وثيقة بصيغة JPEG/PNG، ويستطيع المدير مراجعة الموظفين والوثائق الواقعة ضمن نطاق صلاحياته. يعيد الخادم بناء الصورة ويحذف بياناتها الوصفية قبل حفظها في Supabase الخاص؛ ملفات PDF وبقية الصيغ غير مقبولة في هذا الإصدار. لا يحتوي إصدار الإطلاق على دخول تجريبي أو بيانات صناعية. مسار Render المجاني هو تجربة تشغيل مضبوطة وليس إنتاجًا صحيًا معتمدًا.

## Workspace

| Package                                | Purpose                                            |
| -------------------------------------- | -------------------------------------------------- |
| `artifacts/health-docs`                | React/Vite web application                         |
| `artifacts/api-server`                 | Express API, authentication, RBAC, OCR and storage |
| `lib/db`                               | Drizzle schema and migrations                      |
| `lib/api-spec`                         | OpenAPI source of truth                            |
| `lib/api-client-react` / `lib/api-zod` | Generated clients and validators                   |

## Requirements

- Node.js 24
- pnpm 11.19.0 (Corepack is fine)
- PostgreSQL for API runtime
- Private document storage: the encrypted single-host filesystem acceptance
  profile or a server-mediated private S3-compatible provider. The controlled
  image path accepts only JPEG/PNG up to 8 MiB and rebuilds every input as a
  metadata-free JPEG before persistence. PDF/general-file intake stays
  fail-closed until an approved malware scanner and lifecycle controls exist.

## Local setup

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `DATABASE_URL` and a unique `SESSION_SECRET` in `.env`. For a disposable development database only:

```bash
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run dev
```

Run the web app separately:

```bash
pnpm --filter @workspace/health-docs run dev
```

اختبر مسار الموظف على عرض جوال أيضًا: تسجيل الدخول، فتح «وثائقي»، رفع صورة JPEG/PNG، تعبئة البيانات، ومراجعة حالة الوثيقة. مسار الرفع يعيد بناء الصورة على الخادم ولا يرسلها إلى OCR؛ لا تُفعّل المعالجة الخارجية إلا بعد اعتماد إعداداتها وتدفق الخصوصية الموثق.

The API reads the root `.env` only in its `dev` command. Production `start` expects environment variables from the deployment platform.

## Quality and builds

```bash
pnpm run typecheck
pnpm run test
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/health-docs run build:production
```

The repository has focused automated tests for API security and the responsive web application. It still has no lint configuration, so CI does not claim to run lint. Add further commands only with real configuration and tests. Generated API code can be refreshed with:

```bash
pnpm --filter @workspace/api-spec run codegen
```

## Production checklist

The repository contains guarded Google Cloud Dammam and OCI Riyadh reference
paths. They are not approved for real credential uploads in this release.
See [docs/GOOGLE_CLOUD_DEPLOYMENT.md](docs/GOOGLE_CLOUD_DEPLOYMENT.md) or
[infra/oci/README.md](infra/oci/README.md). The Google path includes a reviewed
Cloud Shell bootstrap; the OCI path remains gated on a verified tenancy and
explicit charge approval. Direct GCS/OCI browser uploads currently lack a
provider-side byte cap and malware quarantine, so those profiles are synthetic
acceptance references only. Data flows,
provider setup, retention assumptions, and remaining approval decisions for
GCS/Oracle Object Storage, Gemini, Resend, and workflow automation are documented in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

When managed-cloud billing is unavailable, the repository also includes a
Windows single-host **acceptance** profile in
[infra/local-production/README.md](infra/local-production/README.md), exposed
only through the named Cloudflare Tunnel documented in
[infra/cloudflare/README.md](infra/cloudflare/README.md). It uses loopback-only
PostgreSQL, encrypted private filesystem storage, restricted ACLs, local
Windows Defender screening, backups, and a restore drill. This profile is for
controlled delivery/acceptance and is not managed healthcare production: it
has one host, no HA/PITR, and no off-site disaster recovery by itself.

إنشاء أول حساب إدارة في قاعدة جديدة مسار مستقل ومحمي بلا كلمة مرور افتراضية؛
اتبع قسم **First production administrator** في دليل Google Cloud ولا ترسل كلمة
المرور في المحادثات أو ملفات المستودع. الأتمتة الاختيارية تستخدم transactional
outbox وعاملًا منفصلًا يوقع أحداثًا مصغرة قبل إرسالها إلى مستلم مركزي معتمد؛
راجع [docs/PRODUCTION_AUTOMATION.md](docs/PRODUCTION_AUTOMATION.md) قبل ربط n8n.

اسم المنتج المعتمد للواجهة هو **Watha'iqi Health | وثائقي الصحية**، والدومين
المملوك هو `wathaiqihealth.com`، ويُخصص `app.wathaiqihealth.com` للإنتاج بعد
اجتياز بوابات النشر والأمان. لا يُعد شراء الدومين موافقة على العلامة التجارية؛ خطوات فحص
SaudiNIC وSAIP موثقة في
[docs/BRAND_AND_DOMAIN.md](docs/BRAND_AND_DOMAIN.md).

For the no-card external acceptance path, use the Docker-based Render service
and the existing Supabase project only through the guarded runbook in
[docs/RENDER_SUPABASE_DEPLOYMENT.md](docs/RENDER_SUPABASE_DEPLOYMENT.md).
The checked-in `render.yaml` deliberately keeps deploys manual: migrations run
with a separate database identity before the web service is released, and the
web service never receives bootstrap or migration credentials. It enables the
bounded `raster-sanitizer` profile: account, employee, dashboard, scoped
administration data, and rebuilt JPEG document images persist in Supabase.
PDFs and other general files remain unavailable until an approved malware
scanner passes readiness. This is not a production-ready healthcare deployment.

- Use a secret manager and a random `SESSION_SECRET` of at least 32 characters.
- Apply reviewed Drizzle migrations; do not use `push-force` in production.
- Provision private object storage and verify retention, image sanitization, file-size quotas, and orphan cleanup. Add approved malware scanning before accepting PDF or general files.
- Attach a least-privilege runtime identity. GCS uses Google Application Default Credentials; OCI customer secret keys must come from OCI Vault and never from a committed file.
- Configure Gemini only after approving the privacy/data-processing terms for uploaded workforce documents.
- Configure and verify the email provider before enabling outbound messages.
- Add a distributed rate limiter and production observability before exposing authentication or OCR publicly at scale.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md) before changing the project.
