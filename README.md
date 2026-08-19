# Health Credential Hub

منصة عربية/إنجليزية لإدارة وثائق واعتمادات الكوادر الصحية، مع لوحة ويب، تطبيق Expo، API، تخزين ملفات خاص، قراءة OCR اختيارية، تنبيهات، وتقارير امتثال. يتضمن المستودع Demo متكاملًا للأدوار الخمسة، لكنه مغلق تلقائيًا في الإنتاج.

> **التركيز الحالي:** الموقع المتجاوب هو واجهة المنتج الأساسية. يستطيع الموظف من الجوال إدخال بياناته ورفع وثائقه يدويًا أو اختيار القراءة الذكية، ومتابعة حالة وثائقه وتنبيهاته. تطبيق Expo وواجهة الـmockup محفوظان كمرجع، لكن التطوير الجديد يبدأ من `artifacts/health-docs` ما لم تتغير الخطة صراحةً.

## Workspace

| Package | Purpose |
| --- | --- |
| `artifacts/health-docs` | React/Vite web application |
| `artifacts/mobile` | Expo mobile application |
| `artifacts/api-server` | Express API, authentication, RBAC, OCR and storage |
| `artifacts/mockup-sandbox` | UI mockup/reference application |
| `lib/db` | Drizzle schema and migrations |
| `lib/api-spec` | OpenAPI source of truth |
| `lib/api-client-react` / `lib/api-zod` | Generated clients and validators |

## Requirements

- Node.js 24
- pnpm 11.19.0 (Corepack is fine)
- PostgreSQL for API runtime
- An object-storage bucket for document uploads

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

اختبر مسار الموظف على عرض جوال أيضًا: تسجيل الدخول، فتح «وثائقي»، رفع ملف، تعبئة البيانات، ومراجعة حالة الوثيقة. الرفع اليدوي لا يرسل الملف إلى OCR؛ خيار «القراءة الذكية» وحده يستدعي خدمة المعالجة الخارجية.

The API reads the root `.env` only in its `dev` command. Production `start` expects environment variables from the deployment platform.

## Demo data

The seed resets its target database. Use it only with a disposable development database:

```bash
ALLOW_DEMO_SEED=true pnpm --filter @workspace/api-server run seed:demo
```

Enable role-based one-click demo login locally with `DEMO_LOGIN_ENABLED=true`. Both the endpoint and seeded accounts are rejected by default when `NODE_ENV=production`. Never enable the demo seed against production data.

## Quality and builds

```bash
pnpm run typecheck
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/health-docs run build
pnpm --filter @workspace/mockup-sandbox run build
EXPO_PUBLIC_DOMAIN=ci.invalid BASE_PATH=/ pnpm --filter @workspace/mobile run build
```

The repository currently has no lint configuration or automated test suite, so CI does not claim to run them. Add those commands only with real configuration and tests. Generated API code can be refreshed with:

```bash
pnpm --filter @workspace/api-spec run codegen
```

## Production checklist

- Keep `DEMO_LOGIN_ENABLED`, `ALLOW_DEMO_SEED`, `SELF_REGISTRATION_ENABLED`, and `GOOGLE_AUTO_PROVISION_ENABLED` false unless explicitly required.
- Use a secret manager and a random `SESSION_SECRET` of at least 32 characters.
- Apply reviewed Drizzle migrations; do not use `push-force` in production.
- Provision private object storage and verify retention, malware scanning, file-size quotas, and orphan cleanup.
- The current storage client authenticates through the Replit sidecar; configure another Google Cloud authentication strategy before deploying outside Replit.
- Configure Gemini only after approving the privacy/data-processing terms for uploaded workforce documents.
- Configure Google OAuth redirect domains and an email provider if those features are enabled.
- Add a distributed rate limiter and production observability before exposing authentication or OCR publicly at scale.
- إذا أُعيد تفعيل تطبيق Expo مستقبلًا، استخدم EAS أو مسار إصدارات الجوال المعتمد في الجهة لبنائه وتوقيعه.

`pnpm audit --prod` currently reports two high-severity denial-of-service advisories in Metro's transitive `image-size@1.2.1`. The registry advertises `2.0.3` as patched, but that version is not published yet. The dependency is used by the Expo build toolchain rather than the API runtime; monitor Expo/Metro and upgrade as soon as a compatible patched release exists.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [AGENTS.md](AGENTS.md) before changing the project.
