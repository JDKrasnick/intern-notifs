# InternNotifs project memory

## Product in one sentence

InternNotifs is a lightweight, simple mobile internship radar: it notifies students when credible technical internships appear and gets them quickly to the employer's official application form.

## Product direction

- Initial audience: international and domestic undergraduate/graduate students.
- Initial scope: technical internships only (software engineering, AI/ML, data, infrastructure/cloud, security, quantitative, product, and technical design).
- Browse first: the public catalog requires no account. Ask for an account only to save applications, enable personal alerts, or store a résumé/profile.
- Applications are always handed off to the employer's official form. Do not automate submission without an authorized partner integration.
- The experience should remain free, calm, privacy-respecting, open-source-friendly, and **simple and clean**. One clear primary action per screen; prefer native mobile controls and plain language.
- Authentication today is email/password plus verification. Sign in with Apple is the next iPhone improvement; Google sign-in is deferred and must ship alongside Sign in with Apple on iOS.

The detailed product tracker is [`docs/product-roadmap.md`](docs/product-roadmap.md). Keep its milestone statuses and checkboxes current when work lands.

## Owner preferences

- Repository: `JDKrasnick/intern-notifs`; owner GitHub handle: `JDKrasnick`.
- Make small, atomic or medium-sized commits and keep CI green. Preserve unrelated dirty working-tree changes.
- Use AWS through the configured `intern-notifs` assumed role in the CLI; validate the active principal with `aws sts get-caller-identity`. Never use root credentials or commit credentials.
- The owner handles Apple/App Store Connect UI and physical-device testing when required. Agents can launch EAS builds and submissions after approval.

## Read before release work

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): infrastructure, EAS/TestFlight, release commands, and operational identifiers.
- [`docs/testflight-checklist.md`](docs/testflight-checklist.md): physical-device acceptance checklist.
- [`docs/PRODUCT_DECISIONS.md`](docs/PRODUCT_DECISIONS.md): authentication and App Store launch decisions.
- [`docs/FRONTEND_DESIGN.md`](docs/FRONTEND_DESIGN.md): frontend principles and Sign in with Apple design constraints.

## Security boundary

Do not put passwords, AWS credentials, Apple private keys, App Store Connect API keys, personal email addresses, or Expo tokens in Git, documentation, or mobile `EXPO_PUBLIC_*` variables. The IDs and URLs declared public below are configuration identifiers, not secrets.
