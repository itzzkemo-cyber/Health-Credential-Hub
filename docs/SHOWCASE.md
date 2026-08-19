# Health Credential Hub — Showcase handoff

هذه نسخة عرض للواجهة الأساسية على الويب، مهيأة لتجربة مسار الموظف من الجوال دون قاعدة بيانات أو تخزين أو مفاتيح API.

## تشغيل العرض

```bash
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm demo:web
```

افتح `http://localhost:4173`، ثم اختر حساب «ممرضة / موظف». لا توجد كلمة مرور في هذا المسار.

## التحقق على شاشة جوال بعرض 390px

استخدم أدوات المطور لضبط مساحة العرض على `390px`، ثم نفّذ الرحلتين بالعربية والإنجليزية. تأكد من ظهور شريط العرض التجريبي دائمًا، ومن عمل اتجاه RTL/LTR والتنقل بلوحة المفاتيح دون تمرير أفقي.

### العربية

1. اختر حساب «ممرضة / موظف»، وراجع ملخص الوثائق والتنبيه القريب من الانتهاء.
2. افتح «وثائقي»، ثم افتح وثيقة صناعية وتحقق من عرض بياناتها ومعاينتها.
3. اختر «رفع» ثم «إدخال يدوي»، وحدد صورة أو PDF. يجب أن توضّح الواجهة أن الملف يبقى في ذاكرة الجهاز ولا يُرفع أو يُرسل خارجيًا.
4. أكمل الحقول واحفظ الوثيقة، ثم افتحها من القائمة.
5. أعد رحلة الرفع واختر «القراءة الذكية» ثم «استخدام وثيقة نموذجية». راجع القيم التي تعبئها المحاكاة وصححها قبل الحفظ.
6. احذف وثيقة من العرض. الحذف محلي ويزيل بيانات صناعية من جلسة العرض الحالية فقط؛ لا يحذف ملفًا أو سجلًا إنتاجيًا.
7. حدّث الصفحة وتأكد من عودة البيانات الصناعية الافتراضية واختفاء الملفات المؤقتة من الذاكرة.
8. اختر «إعادة التجربة» وتأكد من مسح جلسة العرض والعودة إلى البداية بأمان.

### English

1. Choose the “Employee / Nurse” account and review the document summary and upcoming-expiry alert.
2. Open “My Docs,” then open a synthetic document and check its details and preview.
3. Choose “Upload,” switch to “Manual Entry,” and select an image or PDF. The UI must say that the file stays in device memory and is not uploaded or sent externally.
4. Complete the fields, save the document, and open it from the list.
5. Repeat the upload journey with “Smart Scan,” then choose “Use a sample document.” Review and correct the values filled by the simulation before saving.
6. Delete a document in the showcase. Deletion is local and removes synthetic data only from the current showcase session; it does not delete a production file or record.
7. Refresh the page and confirm that default synthetic data returns and temporary in-memory files disappear.
8. Choose “Reset demo” and confirm that the showcase session is cleared and returns safely to the beginning.

## حدود العرض

- جميع الأسماء والوثائق والتنبيهات صناعية.
- الملفات المختارة تبقى في ذاكرة الجهاز داخل تبويب المتصفح فقط، ولا تُرفع إلى خادم ولا تُرسل إلى OCR أو أي خدمة خارجية.
- القراءة الذكية محاكاة ثابتة وآمنة لأغراض العرض.
- عرض الوثائق وحفظها وحذفها عمليات محلية على بيانات صناعية؛ لا تغيّر أي سجل أو ملف إنتاجي.
- تحديث الصفحة يعيد بيانات الوثائق الصناعية ويمسح الملفات المؤقتة؛ زر «إعادة التجربة» يمسح جلسة العرض.
- إعداد المصادقة الثنائية والتكاملات الخارجية معطل بوضوح في هذا الوضع.

## التشغيل الكامل

التشغيل الكامل منفصل عن الـShowcase ويحتاج PostgreSQL، و`SESSION_SECRET` فريدًا، وتخزين ملفات خاصًا. Gemini وGoogle OAuth والبريد تكاملات اختيارية حسب متطلبات الجهة. استخدم `.env.example` ولا تضع أسرارًا في المستودع.

قبل تسليم إنتاجي، يلزم كذلك اعتماد الاستضافة، سياسة الاحتفاظ، فحص البرمجيات الخبيثة للملفات، المراقبة، النسخ الاحتياطي، ومراجعة الخصوصية والأمان لدى الجهة.

## تحقق المطور

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm --filter @workspace/health-docs run build
pnpm --filter @workspace/health-docs run build:showcase
```

لا توجد تهيئة lint حقيقية بعد؛ لذلك لا يدّعي المشروع تشغيل lint في CI.
