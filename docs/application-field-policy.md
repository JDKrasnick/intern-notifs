# Application field policy

This is the reviewed source of truth for the headed Greenhouse and Lever pilots. The executable policies are [`src/greenhouse-headed.ts`](../src/greenhouse-headed.ts) and [`src/lever-headed.ts`](../src/lever-headed.ts). The assistant fills only a field that has an exact, unambiguous match and an available profile value; every other field stays for the student.

| Field group | Treatment | Reason |
| --- | --- | --- |
| Full name, explicitly stored first name, explicitly stored last name | Auto-fill | Basic contact details with an exact profile mapping. Do not split a full name automatically. |
| Email, phone | Auto-fill | Basic contact details with an exact profile mapping. |
| Résumé/CV | Review required | The student selects and confirms the document; the assistant does not attach a file silently. |
| Location, work authorization, sponsorship, education, employment, links, free-text questions | Review required | These answers are often contextual, stale, sensitive, or use employer-specific meanings. |
| Gender, race/ethnicity, veteran status, disability, other voluntary self-identification | Never fill | Voluntary and sensitive. |
| Consent, privacy/terms acknowledgement, CAPTCHA, login/MFA/email/identity verification, final submission | Never fill or click | These are explicit student decisions or portal security checkpoints. |

## Quick Apply detection

The pilot recognizes only a single visible, enabled Greenhouse button/link whose accessible name is exactly one of:

- `Quick Apply with MyGreenhouse`
- `Autofill with Greenhouse`
- `Quick Apply`

It rejects non-Greenhouse domains, hidden/disabled controls, duplicates, generic **Apply** links, and any page that reports a verification challenge. When it finds one safe control, it scrolls it into view and clicks it only after the student explicitly starts Quick Apply. It never clicks an employer's final submit button.

Raw profile answers are held only in the headed browser companion's memory. Durable API session records contain field references and masked previews, never raw answers.

## Other reviewed ATS routes

Lever is also a reviewed high-confidence route, but only for its direct form URL: `https://jobs.lever.co/<company>/<posting>/apply`. That URL is already the application form, so the companion scrolls to its first editable field and applies the same simple-field policy; it does not hunt for or click a generic **Apply** button. All other destinations remain manual until they receive their own reviewed adapter and tests.
