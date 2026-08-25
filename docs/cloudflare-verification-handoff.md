# Cloudflare cutover verification handoff

## Build under test

- iOS version `1.0.0`, build `20`
- [TestFlight build](https://appstoreconnect.apple.com/apps/6792557963/testflight/ios)
- Backend: `https://intern-notifs.jdkrasnick.workers.dev`

Wait for Apple to finish processing build 20, then install it on a physical iPhone. This development build returns the email verification code inside the app; email delivery is not enabled yet.

## Verification pass

1. Launch signed out and confirm the catalog loads without an account.
2. Open several grouped catalog rows. Confirm role counts and details look coherent and **Apply** opens the employer's official form.
3. Create an account, enter the provided development verification code, sign in, then force-quit and reopen the app. Confirm the session recovers without showing the sign-in screen.
4. Briefly disable networking while reopening the app. Confirm it reports a temporary connection problem without signing the user out. Restore networking and retry.
5. Save an application, change alert preferences, and upload then download a small résumé PDF. Force-quit and verify the saved state remains.
6. Enable notifications and confirm the device registers successfully. A real grouped push/release delivery remains a separate pipeline acceptance test.
7. Delete the account. Confirm the app signs out and the previous session no longer works.

## Pass criteria

- No Cognito-specific errors or AWS API URLs appear.
- Guest browsing, grouped catalog/details, authentication, session recovery, private data, and deletion all work against Cloudflare.
- Temporary network failures preserve a valid session; an actually rejected session returns to sign-in.
- No crash, indefinite spinner, duplicate action, or unexpected permission prompt occurs.

## Known follow-ups

- `canadian-tech-2027` is intentionally dormant and currently returns 404 for its missing 2027 README. Other source fleets completed the backfill.
- Before public beta, configure verification email delivery and disable `AUTH_DEV_MODE`.
- AWS is retained for rollback/export and has not been deleted.

For a failure, record the build number, time and timezone, screen, steps, expected/actual behavior, and a screenshot or screen recording. Do not include passwords, verification codes, session tokens, or résumé contents.
