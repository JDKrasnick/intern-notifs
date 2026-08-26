# InternNotifs

<p align="center">
  <img src="mobile/assets/icon.png" alt="InternNotifs — a rising path through an N toward a notification signal" width="180" />
</p>

<p align="center"><strong>A lightweight, open-source radar for technical internships and early-career roles.</strong></p>

InternNotifs helps students stay confidently up to date without repeatedly
refreshing job boards or maintaining a complicated application CRM. It watches
credible employer and community sources, makes genuinely new opportunities
obvious, and gets the student quickly to the employer's official application
form.

The experience is designed for short gaps between classes: calm, fast, and
useful at a glance. Public browsing, device notification settings, and personal
push alerts work without an account. An account is needed only for private data
that should sync, such as saved applications, a résumé, or a reusable profile.

## What it does

- Monitors reviewed Greenhouse, Lever, Ashby, and community sources for
  technical internships, co-ops, apprenticeships, new-grad programs, and
  explicitly entry-level roles.
- Shows source provenance, freshness, location, compensation, education, and
  work-authorization context without copying full employer job descriptions.
- Sends personalized, device-scoped alerts with filters, quiet hours, and
  duplicate-safe deep links.
- Hands every application off to the employer's official form; InternNotifs
  never submits a non-partner application for the user.
- Provides optional saved-role tracking, application status, résumé storage,
  and user-controlled form assistance behind a verified account.
- Keeps the core product free, privacy-respecting, and open to public review.

## Product principles

1. Keep the student informed, not busy.
2. Prefer a short path to the official application over workflow complexity.
3. Make the interface feel native, focused, and accessible.
4. Use personality for genuinely new opportunities—not ambient noise.
5. Keep the app lightweight enough to replace manual repository refreshes.

See [`PRODUCT.md`](PRODUCT.md) for the complete product brief and
[`docs/product-roadmap.md`](docs/product-roadmap.md) for current milestones.

## Architecture

| Area | Implementation |
| --- | --- |
| Mobile | Expo SDK 55, React Native, iOS first |
| API and authentication | Cloudflare Workers with verified email/password accounts and opaque sessions |
| Catalog and private records | Cloudflare D1 |
| Résumés and documents | Private Cloudflare R2 objects behind authenticated routes |
| Ingestion and notifications | Cron Triggers, Queues with DLQs, and Expo Push Service |
| Infrastructure | OpenTofu with Cloudflare provider v5 |

The public catalog and account-free device alerts are installation-scoped.
Profiles, documents, and synced application records are isolated to the
verified account that owns them.

## Local development

Install and verify the backend from the repository root:

```bash
npm ci
npm run lint
npm run typecheck
npm test
```

Run the mobile client with the public environment variables described in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md):

```bash
cd mobile
npm ci
npx expo start
```

Use a physical iOS or Android device for notification delivery and deep-link
testing. Emulator checks cannot prove Expo/APNs/FCM delivery.

## Trust and release documentation

- [Privacy Policy](docs/privacy.html)
- [Terms of Use](docs/terms.html)
- [Data Retention Policy](docs/retention.html)
- [Source and Correction Policy](docs/source-policy.html)
- [Support and account deletion](docs/support.html)
- [Store disclosure worksheet](docs/store-disclosures.md)
- [TestFlight checklist](docs/testflight-checklist.md)

## License

InternNotifs source code is available under the [MIT License](LICENSE).
InternNotifs-created catalog metadata is available under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); employer-authored
text, third-party source material, logos, and trademarks are excluded.
