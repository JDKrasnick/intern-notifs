import {
  detectGreenhouseQuickApply,
  isGreenhouseApplicationUrl,
  planGreenhouseFields,
  type GreenhousePage,
} from './greenhouse-headed.js';
import { isLeverApplicationUrl } from './lever-headed.js';

const probeProfile = { contact: { name: '', email: 'probe@example.invalid' } };

/**
 * The companion is deliberately absent from listings and arbitrary pages. It
 * appears only on an exact Quick Apply control or a reviewed application form
 * with at least one simple contact field. Challenges always suppress it.
 */
export function shouldShowBrowserCompanion(page: GreenhousePage) {
  if (page.challenge) return false;
  const hasSimpleContactField = planGreenhouseFields(page, probeProfile)
    .some((field) => field.treatment === 'auto-fill');
  if (isGreenhouseApplicationUrl(page.url)) {
    return detectGreenhouseQuickApply(page).outcome === 'ready' || hasSimpleContactField;
  }
  return isLeverApplicationUrl(page.url) && hasSimpleContactField;
}
