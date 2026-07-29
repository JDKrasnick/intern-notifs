import {
  planGreenhouseFields,
  type GreenhousePage,
  type HeadedGreenhouseBrowser,
  type SimpleApplicantValues,
} from './greenhouse-headed.js';

export type LeverDetection =
  | { outcome: 'ready'; scrollTargetId?: string }
  | { outcome: 'manual'; reason: 'not-lever-apply-url' | 'challenge' };

/**
 * Reviewed Lever URLs are already direct application forms. There is no
 * generic Apply link to click; opening this exact path is the safe handoff.
 */
export function isLeverApplicationUrl(url: string) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return parsed.hostname.toLowerCase() === 'jobs.lever.co'
      && segments.length === 3
      && segments[2].toLowerCase() === 'apply';
  } catch {
    return false;
  }
}

export function detectLeverApplication(page: GreenhousePage): LeverDetection {
  if (!isLeverApplicationUrl(page.url)) return { outcome: 'manual', reason: 'not-lever-apply-url' };
  if (page.challenge) return { outcome: 'manual', reason: 'challenge' };
  return {
    outcome: 'ready',
    scrollTargetId: page.fields.find((field) => field.visible && field.enabled)?.id,
  };
}

/**
 * Lever's reviewed URLs open directly to the form. The assistant scrolls to
 * the first editable field and fills only the shared exact-contact policy.
 */
export function runLeverHeadedAssistant(
  browser: HeadedGreenhouseBrowser,
  page: GreenhousePage,
  values: SimpleApplicantValues,
) {
  const detection = detectLeverApplication(page);
  const fields = planGreenhouseFields(page, values);
  if (detection.outcome === 'ready' && detection.scrollTargetId) {
    browser.scrollIntoView(detection.scrollTargetId);
  }
  for (const field of fields) {
    if (field.treatment !== 'auto-fill' || !field.resolved || !field.valueRef) continue;
    const value = field.valueRef.key === 'contact.name' ? values.contact.name
      : field.valueRef.key === 'contact.firstName' ? values.contact.firstName
        : field.valueRef.key === 'contact.lastName' ? values.contact.lastName
          : field.valueRef.key === 'contact.email' ? values.contact.email
            : field.valueRef.key === 'contact.phone' ? values.contact.phone
              : undefined;
    if (value) browser.fill(field.controlId, value);
  }
  return { detection, fields };
}
