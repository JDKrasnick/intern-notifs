# Mobile authentication and notification reliability handoff

Status: investigation complete; fixes not yet implemented

Last updated: 2026-08-23

Relevant branch commit: `7df22f96823cbc24dd3c38835753ea4b8d0e5966`

## Objective

Prevent notification opens and normal account reads from trapping a signed-in user on an unrecoverable account error. The app should refresh valid sessions automatically, distinguish revoked credentials from temporary connectivity problems, and always offer a useful recovery path.

This handoff also tracks the separate production-capacity failure that displayed `Service Unavailable`, plus the grouped-release screen exit that proved difficult to discover during physical-device QA.

## User-visible incidents

Two independent failures occurred during physical TestFlight QA:

1. A grouped notification opened to both `We couldn't load your account — Service Unavailable` and `Could not open release — Service Unavailable`.
   - API Gateway returned 5xx responses.
   - The public API Lambda was throttled because the account-wide concurrent-execution quota was 10 while scheduled ingestion workers overlapped.
2. A later notification open displayed an account-processing/authorization failure and left Sign out as the only practical escape.
   - API Gateway recorded four 4xx responses in the incident minute and no corresponding Lambda failure.
   - Cognito ID tokens use the default lifetime of approximately one hour. Refresh tokens are valid for 30 days.
   - Earlier mobile builds persisted and reused the ID token without refreshing it.

The first incident is capacity-related. The second is session-related. They require separate fixes and acceptance tests.

## Current behavior and code

Commit `7df22f9` added the first session-refresh implementation:

- [`mobile/src/auth.ts`](../mobile/src/auth.ts) stores refreshable Cognito sessions, refreshes within five minutes of ID-token expiry, migrates the Cognito library cache, and clears credentials Cognito explicitly rejects.
- [`mobile/src/api.ts`](../mobile/src/api.ts) stores the refreshable session and retries safe reads after HTTP 429, 502, 503, and 504 responses.
- [`mobile/App.tsx`](../mobile/App.tsx) restores at startup, refreshes every 45 minutes and on foreground activation, and refreshes before opening a grouped release.
- [`mobile/test/auth.test.ts`](../mobile/test/auth.test.ts) and [`mobile/test/api.test.ts`](../mobile/test/api.test.ts) contain the initial regression coverage.

This fixed the normal physical-device path in TestFlight build 19: a production grouped notification opened without an account error, and the API/Lambda window contained no 4xx, 5xx, errors, or throttles.

## Confirmed remaining reproductions

The exact failure remains reproducible on the current code when local storage contains an apparently unexpired legacy ID token but no usable refresh credential:

1. `restoreSession()` reaches the legacy fallback in `mobile/src/auth.ts`.
2. It accepts the token based only on the decoded `exp` value.
3. Account reads send that token to the API.
4. The authorizer rejects it with 401 `Unauthorized`.
5. The account error screen offers Try again and Sign out.
6. Try again resends the same token and loops forever.
7. A grouped-release route also displays `Could not open release — Unauthorized` before exposing the account error underneath.

This was reproduced on iOS 26.5 with both an iPhone 17 Pro and an iPhone 17e simulator in all of these lifecycle states:

- terminated/cold launch;
- background resume;
- foreground route handling;
- repeated account Retry actions.

The storage state is plausible after a partial legacy write, an interrupted upgrade, a cleared Cognito cache, or a token issued by a superseded pool/client. It should be treated as untrusted and recoverable, not as an authenticated session.

Additional confirmed gaps:

- A connection, DNS, or offline failure before an HTTP response is not retried. Only retryable HTTP responses enter the bounded retry loop.
- A transient Cognito refresh failure during cold startup is caught by `App.tsx` as `setReady(true)` without a token. The refresh credential remains stored, but the user sees the signed-out guest experience.
- The account screen's Try again action only repeats the account reads. It does not force a session refresh or classify a 401.
- Authenticated API errors carry only a message. Callers cannot reliably distinguish 401, 429, 503, timeout, and offline failures.
- The grouped-release view has `View all internships` above the matches but no equivalent action after the final match, so users can perceive the view as a dead end.

## Recommended implementation

### 1. Make session restoration explicit

Replace the ambiguous `string | undefined` result with a discriminated outcome or typed errors that distinguish:

- authenticated with a usable ID token;
- signed out because no credentials exist;
- session rejected because Cognito returned `NotAuthorizedException`;
- temporarily unavailable because refresh failed due to network/service conditions.

Do not return a legacy ID token when neither the app's refreshable session nor the Cognito cache supplies a refresh token. Clear only the unusable legacy token and route to a normal sign-in prompt. This may require one sign-in after an unusual upgrade state, but it prevents the permanent Unauthorized loop.

Consider moving `sessionStorage` out of `api.ts` into a dedicated module before adding more auth-aware API behavior. This avoids a circular dependency between the raw HTTP client and Cognito session code.

### 2. Add a bounded authenticated-read recovery path

Introduce an authenticated request helper for safe reads:

1. obtain a usable token;
2. make the request;
3. on the first 401, force one Cognito refresh;
4. retry the safe read once with the replacement token;
5. if Cognito rejects the refresh, clear the session and show sign-in;
6. if refresh fails transiently, preserve storage and show a retryable connection state.

Never create an unbounded 401 loop. Do not automatically retry arbitrary writes. A write rejected by the gateway authorizer may be safe in theory, but callers should not depend on infrastructure-specific assumptions about whether an integration ran.

Account bootstrap and grouped-release reads should use this helper. Audit every `/me/*` GET call so token handling is consistent rather than notification-specific.

If refreshed tokens remain in React state, guard against stale async completions overwriting a newer session. Prefer a single-flight refresh promise so foreground activation, the 45-minute timer, account bootstrap, and notification routing cannot launch parallel refresh requests.

### 3. Give transient refresh failures their own UI

Cold startup must not translate a temporary refresh failure into a signed-out appearance.

Recommended state:

- title: `We couldn't refresh your sign-in.`
- primary action: `Try again`;
- secondary action: `Continue browsing`;
- optional explicit action: `Sign out` under account controls, not as the default recovery.

Retry should rerun session restoration before any account reads. Continue browsing should preserve the refresh credential and allow a later foreground/retry attempt.

### 4. Retry safe transport failures

Extend bounded safe-read retries to fetch failures that occur before an HTTP response, such as connection reset, DNS failure, or offline-to-online transitions.

Constraints:

- preserve the existing 250/500/1000 ms bounded schedule or add small jitter;
- do not retry writes;
- do not turn four 12-second request timeouts into a 48-second frozen screen—use a total deadline or fewer timeout retries;
- preserve the final user-facing distinction between timeout, offline, HTTP 401, and service capacity.

### 5. Make account errors actionable

Use an error type that includes at least `status`, `kind`, and a safe display message. Suggested kinds:

- `unauthorized`;
- `capacity`;
- `timeout`;
- `offline`;
- `unexpected`.

Do not log tokens, usernames, email addresses, authorization headers, or raw Cognito responses.

For 401, Try again must attempt session recovery rather than simply repeating the rejected requests. If no recovery credential exists, replace the error screen with sign-in rather than requiring the user to choose Sign out.

### 6. Close the grouped-release dead end

Keep the focused new-match view, but add a clear action after the final role:

- `View all internships`, or
- a caught-up divider followed by the normal feed.

The existing top action can remain. The user should not need to scroll back to the header to discover how to leave the release view.

### 7. Finish the capacity track

The mobile safe-read retries and public-Lambda throttle alarm are already deployed. Remaining operational work:

- confirm the requested Lambda account-concurrency quota increase was approved and applied;
- while the quota remains 10, prevent Greenhouse, Lever, and Ashby workers/dispatchers from consuming the entire account concurrently;
- stagger schedules or reduce worker concurrency enough to preserve capacity for the public API;
- verify the public API throttle alarm remains `OK` during a full ingestion cycle;
- repeat a grouped-release open while workers are active.

Reserved concurrency cannot be used normally while the account quota is only 10 because Lambda requires an unreserved concurrency buffer.

## Required automated tests

### Session tests

- valid refreshable token is reused;
- near-expiry and expired tokens refresh once;
- concurrent callers share one refresh;
- refreshed token and fallback refresh token are persisted;
- revoked refresh token clears all app and Cognito cache keys;
- transient refresh error preserves stored credentials and returns a retryable outcome;
- valid-looking legacy token without a refresh credential is never returned as authenticated;
- expired legacy token is cleared;
- corrupted refreshable JSON falls back to a complete Cognito cache;
- incomplete Cognito cache does not create an authenticated state;
- explicit sign out cannot be undone by cache migration on the next launch.

### API tests

- GET/HEAD retry 429, 502, 503, and 504 within the bound;
- GET/HEAD retry eligible transport failures within the bound;
- timeout handling obeys a total latency budget;
- POST/PATCH/PUT/DELETE never retry for capacity or transport failures;
- authenticated safe read refreshes and retries exactly once after 401;
- a second 401 terminates recovery and cannot loop;
- transient refresh failure does not clear credentials;
- error classification preserves status without exposing response secrets.

### App/routing tests

- cold grouped-release notification waits for session restoration;
- background and foreground release opens use the latest token;
- notification routing wins over the automatic launch inbox;
- transient session recovery shows Retry and Continue browsing;
- rejected session shows sign-in without an account-error loop;
- AccountLoadError Retry performs session recovery;
- the release view has an exit after its last match.

The three diagnostic tests added during investigation currently document the legacy-token, transient-refresh, and transport-failure behavior. Review their wording and convert them from `currently ...` characterization tests into desired-behavior regression tests as fixes land.

## Manual QA matrix

Use a local mock API/auth harness for controlled 401-to-200, 503-to-200, offline, and timeout transitions. Avoid generating avoidable 4xx traffic against production.

Run on at least one compact iPhone and one larger iPhone:

| Session/network configuration | Cold | Background | Foreground | Expected result |
| --- | --- | --- | --- | --- |
| Valid ID and refresh token | Yes | Yes | Yes | Account and release open normally |
| ID within five-minute refresh margin | Yes | Yes | Yes | One refresh; no visible error |
| Expired ID with valid refresh token | Yes | Yes | Yes | One refresh; no visible error |
| Revoked refresh token | Yes | Yes | Yes | Clean sign-in prompt |
| Legacy ID without refresh token | Yes | Yes | Yes | Clean sign-in prompt; no 401 loop |
| Refresh service temporarily unavailable | Yes | Yes | Yes | Retryable session screen; storage preserved |
| API 503 then 200 | Yes | Yes | Yes | Bounded retry succeeds |
| Offline then online | Yes | Yes | Yes | Bounded retry/recovery succeeds |
| Sustained API failure | Yes | Yes | Yes | Actionable error after finite attempts |

For an approved physical TestFlight build, test a real APNs grouped release in foreground, background, and terminated states. Verify both the focused matches and the bottom path to the full feed. Do not start an EAS build or TestFlight submission without explicit approval for that specific build.

## Acceptance criteria

- A valid refresh token prevents an expired ID token from reaching an authenticated API call.
- A 401 can trigger at most one forced refresh and one safe-read retry.
- Try again can never repeat the same rejected token indefinitely.
- Missing legacy refresh state leads to one normal sign-in, not `We couldn't load your account`.
- Temporary refresh/network failure never clears credentials or silently impersonates an explicit sign-out.
- Revoked credentials are cleared and cannot be rehydrated from Cognito cache.
- A grouped notification opens the intended release after session recovery.
- The release view provides an obvious exit after the final match.
- Safe reads recover from brief capacity and transport failures within a bounded total time.
- Writes remain non-retrying.
- Production QA records and device tokens are not printed or committed.
- Public API 4xx/5xx and Lambda throttle metrics remain clean during the acceptance window.

## Related work and cleanup

- PR #93 contains the grouped-release behavior and the first session-refresh and capacity-retry changes described above.
- Diagnostic characterization tests for the legacy-token, transient-refresh, and transport-failure gaps were added during investigation. Review their wording and land them with the corresponding behavior fixes.
- The fake simulator credentials and simulated notification fixture were removed.
- The temporary production grouped-release record was removed after QA.
- No EAS build or TestFlight submission was performed during the reproduction investigation.

Before implementation, inspect the target worktree and preserve unrelated user work.
