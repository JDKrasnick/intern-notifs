import type { ApplicationFieldDraft } from './application-automation.js';

export type GreenhouseControl = {
  id: string;
  text?: string;
  ariaLabel?: string;
  role?: 'button' | 'link' | 'other';
  visible: boolean;
  enabled: boolean;
};

export type GreenhouseField = {
  id: string;
  label?: string;
  name?: string;
  autocomplete?: string;
  type?: string;
  required: boolean;
  visible: boolean;
  enabled: boolean;
};

export type GreenhousePage = {
  url: string;
  controls: GreenhouseControl[];
  fields: GreenhouseField[];
  challenge?: 'captcha' | 'mfa' | 'email' | 'identity' | 'portal-login' | 'other';
};

export type SimpleApplicantValues = {
  contact: {
    name: string;
    firstName?: string;
    lastName?: string;
    email: string;
    phone?: string;
  };
};

export type FieldTreatment = 'auto-fill' | 'review-required' | 'never-fill';

export type FieldPolicy = {
  key: string;
  label: string;
  treatment: FieldTreatment;
  classification: ApplicationFieldDraft['classification'];
  valueRef?: ApplicationFieldDraft['valueRef'];
  autocomplete: string[];
  aliases: string[];
  types: string[];
};

/**
 * Reviewed field policy for the headed Greenhouse pilot. This deliberately
 * favors false negatives: an unknown or ambiguous field is left untouched.
 */
export const greenhouseFieldPolicy: readonly FieldPolicy[] = [
  {
    key: 'full_name', label: 'Full name', treatment: 'auto-fill', classification: 'standard',
    valueRef: { source: 'profile', key: 'contact.name' },
    autocomplete: ['name'], aliases: ['full name', 'your name', 'name'], types: ['text'],
  },
  {
    key: 'first_name', label: 'First name', treatment: 'auto-fill', classification: 'standard',
    valueRef: { source: 'profile', key: 'contact.firstName' },
    autocomplete: ['given-name'], aliases: ['first name', 'given name'], types: ['text'],
  },
  {
    key: 'last_name', label: 'Last name', treatment: 'auto-fill', classification: 'standard',
    valueRef: { source: 'profile', key: 'contact.lastName' },
    autocomplete: ['family-name'], aliases: ['last name', 'family name', 'surname'], types: ['text'],
  },
  {
    key: 'email', label: 'Email', treatment: 'auto-fill', classification: 'standard',
    valueRef: { source: 'profile', key: 'contact.email' },
    // Greenhouse's live forms declare autocomplete="email" on a text input.
    autocomplete: ['email'], aliases: ['email', 'email address'], types: ['email', 'text'],
  },
  {
    key: 'phone', label: 'Phone', treatment: 'auto-fill', classification: 'standard',
    valueRef: { source: 'profile', key: 'contact.phone' },
    autocomplete: ['tel', 'tel-national'], aliases: ['phone', 'phone number', 'mobile phone'], types: ['tel'],
  },
  {
    key: 'resume', label: 'Résumé', treatment: 'review-required', classification: 'standard',
    valueRef: { source: 'document', key: 'resumeDocumentId' },
    autocomplete: [], aliases: ['resume', 'résumé', 'cv', 'curriculum vitae'], types: ['file'],
  },
  {
    key: 'work_authorization', label: 'Work authorization', treatment: 'review-required', classification: 'sensitive',
    autocomplete: [], aliases: ['work authorization', 'authorized to work', 'will you need sponsorship', 'do you require sponsorship', 'sponsorship', 'visa'], types: [],
  },
  {
    key: 'voluntary_self_identification', label: 'Voluntary self-identification', treatment: 'never-fill', classification: 'voluntary-self-identification',
    autocomplete: [], aliases: ['gender', 'race', 'ethnicity', 'veteran', 'disability', 'self identification', 'voluntary gender self identification'], types: [],
  },
  {
    key: 'consent_or_submission', label: 'Consent or submission', treatment: 'never-fill', classification: 'sensitive',
    autocomplete: [], aliases: ['agree to', 'privacy policy', 'terms', 'submit application', 'submit'], types: [],
  },
];

function normalized(value: string | undefined) {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hostname(url: string) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

export function isGreenhouseApplicationUrl(url: string) {
  const host = hostname(url);
  return host === 'boards.greenhouse.io'
    || host.endsWith('.boards.greenhouse.io')
    || host === 'job-boards.greenhouse.io'
    || host.endsWith('.job-boards.greenhouse.io')
    // Greenhouse's EU regional board host uses this reversed subdomain form.
    || host === 'job-boards.eu.greenhouse.io';
}

function controlName(control: GreenhouseControl) {
  return normalized(`${control.text ?? ''} ${control.ariaLabel ?? ''}`);
}

export type QuickApplyDetection =
  | { outcome: 'ready'; controlId: string; scrollTargetId: string }
  | { outcome: 'manual'; reason: 'not-greenhouse' | 'challenge' | 'not-found' | 'ambiguous' };

/**
 * Finds exactly one visible, enabled MyGreenhouse control. Generic "Apply"
 * controls are never clicked: the label must explicitly name Quick Apply or
 * Greenhouse autofill, protecting against unrelated links and final submit.
 */
export function detectGreenhouseQuickApply(page: GreenhousePage): QuickApplyDetection {
  if (!isGreenhouseApplicationUrl(page.url)) return { outcome: 'manual', reason: 'not-greenhouse' };
  if (page.challenge) return { outcome: 'manual', reason: 'challenge' };
  const candidates = page.controls.filter((control) => {
    const name = controlName(control);
    return control.visible
      && control.enabled
      && (control.role === 'button' || control.role === 'link')
      && (name === 'quick apply with mygreenhouse'
        || name === 'autofill with greenhouse'
        || name === 'quick apply');
  });
  if (!candidates.length) return { outcome: 'manual', reason: 'not-found' };
  if (candidates.length > 1) return { outcome: 'manual', reason: 'ambiguous' };
  return { outcome: 'ready', controlId: candidates[0].id, scrollTargetId: candidates[0].id };
}

function matchingPolicy(field: GreenhouseField) {
  const label = normalized(`${field.label ?? ''} ${field.name ?? ''}`);
  const autocomplete = normalized(field.autocomplete);
  const type = normalized(field.type || 'text');
  const matches = greenhouseFieldPolicy.filter((policy) =>
    (policy.autocomplete.includes(autocomplete) || policy.aliases.some((alias) => label === normalized(alias)))
    && (!policy.types.length || policy.types.includes(type)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function valueFor(policy: FieldPolicy, values: SimpleApplicantValues) {
  switch (policy.valueRef?.key) {
    case 'contact.name': return values.contact.name;
    case 'contact.firstName': return values.contact.firstName;
    case 'contact.lastName': return values.contact.lastName;
    case 'contact.email': return values.contact.email;
    case 'contact.phone': return values.contact.phone;
    default: return undefined;
  }
}

function masked(value: string | undefined) {
  if (!value) return undefined;
  return `${value.slice(0, 1)}•••`;
}

export type GreenhouseFieldPlan = ApplicationFieldDraft & { controlId: string; treatment: FieldTreatment };

/** Creates a field plan with references and masked previews only; never raw values. */
export function planGreenhouseFields(page: GreenhousePage, values: SimpleApplicantValues): GreenhouseFieldPlan[] {
  const visibleFields = page.fields
    .filter((field) => field.visible && field.enabled)
    .map((field) => ({ field, policy: matchingPolicy(field) }));
  const policyMatches = new Map<string, number>();
  for (const { policy } of visibleFields) {
    if (policy?.treatment === 'auto-fill') {
      policyMatches.set(policy.key, (policyMatches.get(policy.key) ?? 0) + 1);
    }
  }
  return visibleFields.map(({ field, policy }) => {
      const value = policy ? valueFor(policy, values) : undefined;
      const canFill = policy?.treatment === 'auto-fill'
        && policyMatches.get(policy.key) === 1
        && Boolean(value);
      return {
        key: policy?.key ?? field.name ?? field.id,
        label: field.label ?? field.name ?? field.id,
        required: field.required,
        resolved: Boolean(canFill),
        classification: policy?.classification ?? 'standard',
        confidence: canFill ? 'exact' : 'unknown',
        ...(canFill && policy?.valueRef ? { valueRef: policy.valueRef } : {}),
        ...(canFill ? { maskedPreview: masked(value) } : {}),
        controlId: field.id,
        treatment: policy?.treatment ?? 'review-required',
      };
    });
}

export interface HeadedGreenhouseBrowser {
  scrollIntoView(controlId: string): void;
  click(controlId: string): void;
  fill(controlId: string, value: string): void;
}

/**
 * Executes only the approved, non-submit actions. The browser companion owns
 * the raw values in memory and must call this only after the student starts
 * Quick Apply. Unknown, sensitive, voluntary, file, and submit controls are
 * never touched.
 */
export function runGreenhouseHeadedAssistant(
  browser: HeadedGreenhouseBrowser,
  page: GreenhousePage,
  values: SimpleApplicantValues,
  approveQuickApply: boolean,
) {
  const quickApply = detectGreenhouseQuickApply(page);
  if (quickApply.outcome === 'ready') {
    browser.scrollIntoView(quickApply.scrollTargetId);
    if (approveQuickApply) browser.click(quickApply.controlId);
  }
  const fields = planGreenhouseFields(page, values);
  for (const field of fields) {
    if (field.treatment !== 'auto-fill' || !field.resolved || !field.valueRef) continue;
    const policy = greenhouseFieldPolicy.find((item) => item.key === field.key);
    const value = policy ? valueFor(policy, values) : undefined;
    if (value) browser.fill(field.controlId, value);
  }
  return { quickApply, fields };
}
