import {
  detectGreenhouseQuickApply,
  isGreenhouseApplicationUrl,
  planGreenhouseFields,
  type GreenhouseControl,
  type GreenhouseField,
  type GreenhousePage,
  type SimpleApplicantValues,
} from '../src/greenhouse-headed.js';
import { detectLeverApplication, isLeverApplicationUrl } from '../src/lever-headed.js';
import { nextFocusableApplicationField } from '../src/headed-focus.js';
import { shouldShowBrowserCompanion } from '../src/companion-surface.js';

declare const chrome: {
  storage: { local: { get: (key: string, callback: (result: Record<string, unknown>) => void) => void } };
};

type StoredProfile = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  advance?: boolean;
};

type PageSnapshot = GreenhousePage & { elements: Map<string, HTMLElement> };

const pendingQuickFillKey = 'internnotifs.quick-fill-requested';
let filling = false;
let currentProfile: StoredProfile = {};

function normalized(value: string | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function isVisible(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

function isEnabled(element: HTMLElement) {
  return !('disabled' in element && Boolean((element as HTMLInputElement).disabled));
}

function labelFor(element: HTMLElement) {
  const labelledBy = element.getAttribute('aria-labelledby');
  const labelled = labelledBy
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ');
  const explicit = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : '';
  return normalized([
    element.getAttribute('aria-label'), labelled, explicit, element.closest('label')?.textContent,
  ].filter(Boolean).join(' '));
}

function challenge() {
  const body = document.body?.innerText.toLowerCase() ?? '';
  if (document.querySelector('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [data-sitekey]')) return 'captcha' as const;
  if (/\b(one[- ]time code|verification code|multi[- ]factor|two[- ]factor)\b/.test(body)) return 'mfa' as const;
  if (document.querySelector('input[type="password"]')) return 'portal-login' as const;
  return undefined;
}

function snapshot(): PageSnapshot {
  const elements = new Map<string, HTMLElement>();
  const controls: GreenhouseControl[] = Array.from(document.querySelectorAll<HTMLElement>('button, a[href]')).map((element, index) => {
    const id = `control-${index}`;
    elements.set(id, element);
    return {
      id,
      text: normalized(element.textContent),
      ariaLabel: element.getAttribute('aria-label') ?? undefined,
      role: element.tagName === 'BUTTON' ? 'button' : 'link',
      visible: isVisible(element),
      enabled: isEnabled(element),
    };
  });
  const fields: GreenhouseField[] = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select')).map((element, index) => {
    const id = `field-${index}`;
    elements.set(id, element);
    const input = element as HTMLInputElement;
    return {
      id,
      label: labelFor(element),
      name: input.name || undefined,
      autocomplete: input.autocomplete || undefined,
      type: element.tagName === 'TEXTAREA' ? 'text' : element.tagName === 'SELECT' ? 'select' : input.type,
      required: input.required,
      visible: isVisible(element),
      enabled: isEnabled(element),
    };
  });
  return { url: location.href, controls, fields, challenge: challenge(), elements };
}

function values(profile: StoredProfile): SimpleApplicantValues | undefined {
  const firstName = normalized(profile.firstName);
  const lastName = normalized(profile.lastName);
  const email = normalized(profile.email);
  if (!email) return undefined;
  return {
    contact: {
      name: [firstName, lastName].filter(Boolean).join(' '),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      email,
      ...(normalized(profile.phone) ? { phone: normalized(profile.phone) } : {}),
    },
  };
}

function nativeSetValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function isFocusable(element: HTMLElement) {
  if (!isVisible(element) || !isEnabled(element)) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return !element.readOnly;
  if (!(element instanceof HTMLInputElement) || element.readOnly) return false;
  return !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(element.type);
}

function isSimpleAssistable(element: HTMLElement) {
  const applicant = values(currentProfile);
  if (!applicant) return false;
  const page = snapshot();
  return planGreenhouseFields(page, applicant).some((field) =>
    page.elements.get(field.controlId) === element && field.treatment === 'auto-fill',
  );
}

function advanceFrom(element: HTMLElement) {
  if (filling || currentProfile.advance === false || !isFocusable(element) || !isSimpleAssistable(element)) return;
  const fields = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select')).map((candidate, index) => ({
    id: String(index),
    completed: candidate === element ? Boolean((candidate as HTMLInputElement).value.trim()) : Boolean((candidate as HTMLInputElement).value?.trim()),
    visible: isVisible(candidate),
    enabled: isEnabled(candidate),
    focusable: isFocusable(candidate),
  }));
  const currentIndex = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select')).indexOf(element);
  const target = nextFocusableApplicationField(fields, String(currentIndex));
  if (!target) return;
  const next = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select'))[Number(target.id)];
  next?.focus({ preventScroll: true });
  next?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function fillCurrentPage(profile: StoredProfile) {
  const applicant = values(profile);
  if (!applicant) return setStatus('Add your email in the extension first.');
  const page = snapshot();
  const planned = planGreenhouseFields(page, applicant);
  filling = true;
  let filled = 0;
  for (const field of planned) {
    if (field.treatment !== 'auto-fill' || !field.resolved) continue;
    const element = page.elements.get(field.controlId);
    const value = field.valueRef?.key === 'contact.name' ? applicant.contact.name
      : field.valueRef?.key === 'contact.firstName' ? applicant.contact.firstName
        : field.valueRef?.key === 'contact.lastName' ? applicant.contact.lastName
          : field.valueRef?.key === 'contact.email' ? applicant.contact.email
            : field.valueRef?.key === 'contact.phone' ? applicant.contact.phone
              : undefined;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (value && !element.value) {
        nativeSetValue(element, value);
        filled += 1;
      }
    }
  }
  filling = false;
  const firstEmpty = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, select')).find((element) =>
    isFocusable(element) && !(element as HTMLInputElement).value,
  );
  if (profile.advance !== false && firstEmpty) {
    firstEmpty.focus({ preventScroll: true });
    firstEmpty.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  setStatus(filled ? `Filled ${filled} contact field${filled === 1 ? '' : 's'}.` : 'Contact details are already filled.');
}

function runQuickFill() {
  const page = snapshot();
  if (isGreenhouseApplicationUrl(page.url)) {
    const quickApply = detectGreenhouseQuickApply(page);
    if (quickApply.outcome === 'ready') {
      const control = page.elements.get(quickApply.controlId);
      control?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      sessionStorage.setItem(pendingQuickFillKey, '1');
      window.setTimeout(() => control?.click(), 180);
      window.setTimeout(() => fillCurrentPage(currentProfile), 750);
      setStatus('Opening Quick Apply…');
      return;
    }
    if (quickApply.reason === 'challenge') return setStatus('Finish the verification first.');
  }
  if (isLeverApplicationUrl(page.url)) {
    const lever = detectLeverApplication(page);
    if (lever.outcome === 'manual') return setStatus('Finish the verification first.');
  }
  fillCurrentPage(currentProfile);
}

function setStatus(message: string) {
  const status = document.querySelector<HTMLElement>('#internnotifs-quick-fill-status');
  if (status) status.textContent = message;
}

function mount() {
  if (document.getElementById('internnotifs-quick-fill')) return;
  if (!shouldShowBrowserCompanion(snapshot())) return;
  const dock = document.createElement('div');
  dock.id = 'internnotifs-quick-fill';
  dock.innerHTML = '<button type="button" id="internnotifs-quick-fill-button">Quick fill</button><span id="internnotifs-quick-fill-status" role="status" aria-live="polite"></span>';
  const style = document.createElement('style');
  style.textContent = '#internnotifs-quick-fill{align-items:center;background:#0f172a;border-radius:12px;bottom:16px;box-sizing:border-box;color:#fff;display:flex;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;gap:10px;max-width:calc(100vw - 32px);padding:6px 10px 6px 6px;position:fixed;right:16px;z-index:2147483647}#internnotifs-quick-fill-button{background:#fff;border:0;border-radius:8px;color:#0f172a;cursor:pointer;font:600 14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:38px;padding:0 12px}#internnotifs-quick-fill-button:focus-visible{outline:3px solid #67e8f9;outline-offset:2px}#internnotifs-quick-fill-status{font-size:12px;line-height:16px;max-width:152px}';
  document.documentElement.append(style);
  document.documentElement.append(dock);
  dock.querySelector('button')?.addEventListener('click', runQuickFill);
}

document.addEventListener('change', (event) => {
  const element = event.target;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    window.setTimeout(() => advanceFrom(element), 0);
  }
}, true);
document.addEventListener('blur', (event) => {
  const element = event.target;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    window.setTimeout(() => advanceFrom(element), 0);
  }
}, true);

chrome.storage.local.get('internnotifsQuickFill', (stored) => {
  currentProfile = (stored.internnotifsQuickFill as StoredProfile | undefined) ?? {};
  mount();
  const observer = new MutationObserver(() => {
    if (document.getElementById('internnotifs-quick-fill')) {
      observer.disconnect();
      return;
    }
    mount();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (sessionStorage.getItem(pendingQuickFillKey)) {
    sessionStorage.removeItem(pendingQuickFillKey);
    window.setTimeout(() => fillCurrentPage(currentProfile), 300);
  }
});
