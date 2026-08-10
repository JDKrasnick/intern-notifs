import {
  detectGreenhouseQuickApply,
  isGreenhouseApplicationUrl,
  planGreenhouseFields,
  type GreenhousePage,
} from './greenhouse-headed.js';
import { isLeverApplicationUrl } from './lever-headed.js';
import { isAshbyApplicationUrl } from './ashby-headed.js';

const probeProfile = { contact: { name: '', email: 'probe@example.invalid' } };

/**
 * The companion is deliberately absent from listings and arbitrary pages. It
 * appears only on an exact Quick Apply control or a reviewed application form
 * with at least one simple contact field. An eligible form remains visible at
 * a challenge so the student receives the explicit Your turn handoff.
 */
export function shouldShowBrowserCompanion(page: GreenhousePage, ashbySources?: Parameters<typeof isAshbyApplicationUrl>[1]) {
  const hasSimpleContactField = planGreenhouseFields(page, probeProfile)
    .some((field) => field.treatment === 'auto-fill');
  if (isGreenhouseApplicationUrl(page.url)) {
    return Boolean(page.challenge || detectGreenhouseQuickApply(page).outcome === 'ready' || hasSimpleContactField);
  }
  return isLeverApplicationUrl(page.url) || isAshbyApplicationUrl(page.url, ashbySources);
}
