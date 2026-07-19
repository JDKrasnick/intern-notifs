# Product decisions and launch record

## Authentication: browse first

**Decision:** No account is required when the app opens. Anyone can browse the public technical-internship catalog and open an employer's official application immediately.

An account is requested only when a person chooses a feature that stores or personalizes private data:

- saved application tracking;
- push alerts and role filters;
- résumé and reusable application profile; or
- using that data on another device.

This is intentionally not an anonymous shared account. Private data continues to be scoped to a Cognito user once someone elects to create an account.

## Authentication roadmap

- **Now:** email/password sign-up with email verification, used only after a user opts into private features.
- **Next (iPhone):** Sign in with Apple, backed by Cognito federation. See `FRONTEND_DESIGN.md` for the required Apple and AWS setup.
- **Later:** Google sign-in through the same Cognito federation layer.

Google sign-in should not be enabled by itself on iOS; when it is offered, Sign in with Apple must also be offered to satisfy Apple's equivalent-login policy. Apple and Google keys stay server-side and are never included in the Expo app.

## Store-launch checklist

### Product and release

- [ ] Test the browse-first flow, account creation, email verification, filters, alerts, application tracking, résumé upload, sign-out, and account deletion on a physical iPhone.
- [ ] Test notification permission approval and denial, a real push alert, and its job deep link.
- [ ] Confirm the deployed catalog has enough current technical internships and that every source link reaches the employer's official application.
- [ ] Produce and install a fresh TestFlight build after the browse-first change; build 3 cannot contain later commits.
- [ ] Resolve all TestFlight feedback and crashes.

### Required App Store materials

- [ ] Publish a privacy-policy URL and a support/contact URL, then supply both through Expo release configuration and App Store Connect.
- [ ] Complete App Privacy answers accurately: account contact data, résumé/profile content, application tracking, and device notification token handling.
- [ ] Provide the 1024×1024 app icon, App Store screenshots, description, subtitle, keywords, category, age rating, and support URL.
- [ ] Set App Review contact information and clear reviewer notes. Explain that catalog browsing requires no account; provide a test account only if a reviewer needs to test private features.
- [ ] Complete export-compliance, pricing/availability, content-rights, and release settings in App Store Connect.

### Before pressing release

- [ ] Merge the release branch only after CI passes and the new TestFlight build is accepted.
- [ ] Submit the chosen build for App Review and respond to any review questions.
- [ ] Choose manual release for a final human check, or automatic release after approval.

## Not launch blockers

Sign in with Apple and Google sign-in are quality improvements, not prerequisites for this initial email-based release. If Google is added, Sign in with Apple becomes part of that same release.
