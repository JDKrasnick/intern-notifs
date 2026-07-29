# Application assistance architecture

## Scope and trust boundary

InternNotifs can help a student prepare and fill an employer's official application, but a non-partner integration must never submit it. The student reviews every answer, completes any portal verification, and operates the employer's final submit control.

CAPTCHA, MFA, email verification, identity checks, portal login, and similar challenges are pause-and-handoff events. InternNotifs does not solve, outsource, or bypass them.

The shared session lifecycle is:

`created → filling → needs input → user review → portal verification (when encountered) → ready for user submit → submitted`

Portal verification can interrupt filling, review, or the final page. After the user completes it, the runner resumes at the interrupted checkpoint.

## Route 1: headed assistant

The headed assistant runs in a browser the student can see and control, initially as a desktop browser extension or companion browser experience. A mobile in-app browser cannot reliably inject into arbitrary employer forms, so the Expo client should hand off a short-lived application session to that browser.

The assistant may:

- identify supported fields and fill high-confidence profile values;
- attach the selected résumé from a short-lived download URL;
- flag unknown, inferred, sensitive, and voluntary self-identification questions;
- navigate multi-page forms after the user approves the next step; and
- stop immediately when it detects verification or reaches the final submit control.

The first production pilot should be headed. It keeps authentication and portal cookies on the student's device, makes selector failures visible, and gives the student the clearest control.

The reviewed Greenhouse and Lever detectors plus field treatment policy live in [`src/greenhouse-headed.ts`](../src/greenhouse-headed.ts), [`src/lever-headed.ts`](../src/lever-headed.ts), and [`docs/application-field-policy.md`](application-field-policy.md). Greenhouse scrolls to, and only after an explicit student action clicks, one exact Quick Apply control. Lever accepts only its direct `/apply` form URLs, which need no generic Apply click. Every detector fails closed for unreviewed hosts, ambiguous controls, or verification checkpoints.

## Route 2: headless preparation

The headless runner uses an isolated, ephemeral browser session. It may navigate and prepare a draft, but it must expose a live interactive handoff when login or verification is required and again for final review and submission.

The runner requires additional controls:

- one isolated browser context per application;
- an employer-domain allowlist and strict redirect checks;
- encrypted, short-lived session state with an explicit TTL;
- no durable storage of passwords, cookies, raw field values, page HTML, or screenshots by default;
- auditable state transitions that contain field references and masked previews only;
- immediate cancellation and data destruction; and
- per-employer rate limits and a kill switch.

This route should remain an internal experiment until the headed pilot establishes mappings, failure rates, and employer-policy compatibility.

## Shared components

Both runners consume the same application-field plan and session state machine in `src/application-automation.ts`. Portal adapters should be split into three responsibilities:

1. **Detect:** identify the employer/ATS, page, fields, verification challenges, and final submit control.
2. **Map and fill:** map form fields to profile references, fill only supported values, and report unresolved questions.
3. **Pause and hand off:** return control for sensitive answers, review, verification, and submission.

The durable session contains references such as `profile.contact.name`, resolution status, confidence, classification, and a masked preview. Raw answers are resolved only inside the ephemeral runner.

## Recommended rollout

1. Build the shared draft protocol and state machine.
2. Pilot a headed adapter against one ATS in a test/sandbox job, stopping before submission.
3. Add a review screen showing filled, inferred, missing, sensitive, and voluntary fields.
4. Add challenge detection and browser handoff telemetry without recording challenge contents.
5. Measure fill coverage, correction rate, challenge rate, abandonment, and time saved.
6. Reuse the proven adapter contract in an isolated headless proof of concept.
7. Enable actual partner submission only under the existing authorized-employer feature flag and a separate, explicit approval flow.

## Minimum acceptance criteria

- No runner API exposes a non-partner submit operation.
- A user approval is required after the latest answer change.
- Challenges always pause automation and require the user.
- Unknown required fields block readiness.
- Sensitive and voluntary answers are never inferred.
- Session cancellation destroys ephemeral browser state.
- A domain change, unexpected page, or selector ambiguity fails closed.
- The application tracker marks `applied` only after the user confirms successful submission.
