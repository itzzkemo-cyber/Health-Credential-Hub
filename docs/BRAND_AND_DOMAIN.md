# Watha'iqi Health launch name and domain

Research date: 19 August 2026. Domain status is a point-in-time registry check,
not a reservation and not a trademark clearance.

## Chosen product name

Use **Watha'iqi Health | وثائقي الصحية** as the public product name, with the
descriptive subtitle **Health Workforce Credentials | اعتماد وثائق الكوادر
الصحية** when additional context is useful.

Keep internal repository, package, API, database, bundle, and migration
identifiers stable unless a separately reviewed technical migration requires a
change. The public name does not imply that the service is a regulator,
government authority, or official source of professional licensing.

## Recommended domain

The preferred domain is **`wathaiqihealth.com`**. The Verisign `.com` registry
returned `404` for it during the check, which means no current registration was
returned at that moment. This does not reserve the domain; recheck it at the
registrar and purchase it before publishing links or commissioning a logo.

Suggested hostnames after purchase:

- `app.wathaiqihealth.com` — production application;
- `demo.wathaiqihealth.com` — synthetic stakeholder demo;
- `status.wathaiqihealth.com` — later, for service status only.

The shorter `wathaiqi.com` was already registered when checked. The following
fallbacks also returned `404` at that time: `wathaiqhealth.com`,
`wathaiqih.com`, `wathaeqihealth.com`, `wathaiqiapp.com`, and
`wathaiqi-health.com`. Prefer the primary domain because it matches the English
product name and is easier to explain verbally.

## Checks required before launch

An [App Store product](https://apps.apple.com/sa/app/%D9%88%D8%AB%D8%A7%D8%A6%D9%82%D9%8A/id6781752960)
already uses the Arabic name **«وثائقي»** for tracking organization documents
and expiry reminders, which overlaps with this product's category. Adding
**«الصحية»** improves distinction but is not legal clearance. Treat this as a
material naming risk and do not buy the domain or commission a public identity
until the SAIP search and legal review are complete.

1. Recheck and buy `wathaiqihealth.com` through the chosen registrar.
2. Check `wathaiqihealth.sa` and `wathaiqihealth.com.sa` with a
   [SaudiNIC-accredited registrar](https://nic.sa/).
3. Run [SAIP trademark searches](https://www.saip.gov.sa/en/services/trademarks/trademark1)
   for **Watha'iqi Health**, **Wathaiqi Health**, and **وثائقي الصحية**, then
   obtain legal approval for the word mark and future logo.
4. Configure DNS, TLS, the application base URL, OAuth consent and callback
   domains, email sender identity, support addresses, and legal notices
   together in one reviewed release.
5. Keep the existing GitHub Pages address as a synthetic demo until the
   production Google Cloud deployment and custom domain pass the release
   checklist.
