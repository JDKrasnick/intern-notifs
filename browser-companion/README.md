# InternNotifs Quick Fill browser companion

This is a local-only, headed browser extension pilot for reviewed Greenhouse, Lever, and published Ashby application pages. It never submits an application.

## Install for local testing

1. Run `npm run build:browser-companion` from the repository root.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select this `browser-companion` directory.
4. Open the extension popup and save the contact details you want it to reuse. These values stay in the browser extension's local storage; this pilot does not send them to InternNotifs.

## Behavior

- The companion stays hidden on job listings, search pages, generic employer pages, and unreviewed destinations. On a supported form with a challenge or an unfinished required/sensitive field, it stays visible with a **Your turn** handoff; finish that step and explicitly select **Continue** to recheck the page. It never resumes on its own.
- On a reviewed Greenhouse page, press the compact **Quick fill** control. It scrolls to and opens exactly one MyGreenhouse Quick Apply control when present, then fills only exact simple contact fields.
- On a direct reviewed Lever `/apply` URL, it fills those same fields and moves to the next editable field.
- On a direct published Ashby `/<board>/<posting-uuid>/application` URL, it uses those same exact-contact mappings. Board keys are case-sensitive and come only from `reviewedAshbySources` entries with `status: 'published'`; shadow boards remain unavailable.
- After a student accepts native autofill or leaves a completed simple field, it moves focus to the next editable text-style field when **Advance after a completed field** is enabled.
- It never fills sensitive or voluntary questions, uploads documents, handles a challenge/login, accepts terms, or submits an application.

The extension intentionally rejects any other site and ambiguous or duplicate Quick Apply controls. A challenge on a supported route is a visible handoff, never an automation target. Adding another ATS means adding a reviewed adapter and tests first.

Run `npm run audit:browser-companion` to pull a bounded live sample from the public catalog, fetch one page per host, and verify that the reviewed Greenhouse/Lever/published-Ashby pages still expose a Quick Apply or contact-form surface. It does not submit, fill, sign in, or retain any employer-page data.
