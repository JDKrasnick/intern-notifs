# TestFlight release checklist

Run this from `mobile/` using the intended EAS environment:

```bash
npx eas-cli@latest env:exec production 'npm run release:check'
npx eas-cli@latest build --platform ios --profile testflight --auto-submit
```

Before inviting testers:

- Confirm all three public EAS variables are present in the selected environment: Cloudflare API URL, Privacy Policy URL, and Support URL.
- Run the root backend checks: `npm run lint && npm run typecheck && npm test`.
- Install the TestFlight build on a physical iPhone and create two test accounts. Approve notifications on one and deny them on the other.
- Confirm the approved account registers an Expo token, receives a real push, and opens the corresponding job when the notification is tapped. Confirm denied permission has a clear in-app explanation.
- On physical iOS and Android, tap an open-role alert while the app is foregrounded, backgrounded, and terminated; each tap must open one in-app role sheet with working Back behavior.
- Repeat with a role closed after delivery, then with an invalid job ID. Confirm the closed sheet has no Apply action, only shows a validated official-listing link, and the invalid ID shows the unavailable state.
- Open `internnotifs://jobs/<encoded-job-id>` directly. Confirm retry behavior, duplicate tap protection, source/corroboration and freshness labels, matched-filter wording, guest 72-hour New badges, and VoiceOver/TalkBack output.
- Change include/exclude filters, templates, and role abbreviations; trigger a matching and a non-matching job to confirm delivery behavior.
- Open Privacy Policy and Support in Profile. Verify account deletion removes the signed-in user’s profile, applications, documents, device alerts, Cloudflare sessions, and sign-in identity.
- Inspect the installed icon, launch splash, app version, and auto-incremented build number in TestFlight.
