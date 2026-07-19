# InternNotifs frontend design

## Product posture

InternNotifs should feel calm, competent, and deliberately small. It helps a student notice a relevant internship and take the next useful action; it should never compete for attention with the job search itself.

The design principle is **simple and clean**:

- One clear primary action per screen.
- Show essential information first: company, role, location, season, and the next action.
- Use plain language. Avoid clever labels, excessive badges, and marketing copy.
- Prefer native iPhone controls and predictable gestures over custom interaction patterns.
- Make empty, loading, error, and permission-denied states useful and specific.

## Visual system

Use a quiet off-white canvas (`#F8FAFC`), white surfaces, near-black text (`#0F172A`), and slate supporting text (`#64748B`). The only strong accent is a restrained teal (`#0E7490`) for selected states and positive navigation context.

Cards have one purpose and generous but not wasteful spacing. Corners are softly rounded (12–20 px); shadows should be subtle enough to disappear in a screenshot. Avoid gradients, decorative background blocks, dense borders, and more than one accent color on a screen.

Typography has a simple hierarchy:

| Use | Style |
| --- | --- |
| Screen title | 28 px, bold |
| Section title | 20–22 px, bold |
| Job title / primary content | 16–17 px, semibold |
| Supporting metadata | 14–16 px, regular |
| Labels / helper copy | 12–13 px, medium |

## Layout and interaction rules

Every form must be keyboard-safe: use a safe-area container, `KeyboardAvoidingView`, and a scrollable content area. Content should begin within the safe area and remain reachable on the smallest supported iPhone. Do not vertically center a full form without scrolling; the keyboard turns that into a cropped screen.

Touch targets are at least 44 px tall. Inputs have visible labels, not placeholder-only labels. Destructive actions stay visually separate from routine actions. Native alert dialogs are appropriate for irreversible actions such as account deletion.

## Authentication

The near-term sign-in screen is compact and email/password based: sign in, create account, verify email. There is no shared default login; each tester creates their own account.

The intended iPhone-first end state is **Sign in with Apple** as the primary option, with email/password retained as a fallback. Do not present a non-working Apple button. Before enabling it, configure Apple as a Cognito User Pool identity provider and test the full token return path on a physical device.

Required configuration outside the app code:

1. Enable **Sign in with Apple** for `com.internnotifs.app` in Apple Developer.
2. Create an Apple Sign in with Apple key and record its Key ID, Team ID, and private key securely.
3. Create/configure the Apple Services ID and allowed Cognito callback URL.
4. Configure the Apple provider, Cognito hosted domain, OAuth callback/sign-out URLs, and allowed OAuth flows in the Cognito User Pool.
5. Add the mobile auth-session implementation, then test first sign-in, returning sign-in, private relay email, logout, account deletion, and a full TestFlight build.

The Apple private key must remain in AWS/Apple configuration and must never be embedded in Expo environment variables, the mobile binary, or Git.

## Screen intent

- **Sign in:** establish trust quickly; one task at a time.
- **Onboarding:** select roles and alerts in under a minute; explain that settings remain editable.
- **Feed:** scan roles quickly; each card answers “what is it?” and “where?” before details.
- **Apply:** make the handoff to the employer’s official application explicit; InternNotifs tracks progress, it does not impersonate an employer form.
- **Saved:** show application status without inventing a complex workflow.
- **Profile:** keep reusable application data, résumé, alerts, support, and account control in clearly separated sections.
