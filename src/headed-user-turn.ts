import type { GreenhouseField, GreenhouseFieldPlan, GreenhousePage } from './greenhouse-headed.js';

export type UserTurnReason = 'verification' | 'sensitive-question' | 'unresolved-field';

/**
 * A blocked page must be revisited only through an explicit user action. This
 * function contains no browser action and therefore cannot resume filling.
 */
export function headedUserTurnReason(page: GreenhousePage, fields: readonly GreenhouseFieldPlan[]): UserTurnReason | undefined {
  if (page.challenge) return 'verification';
  const byId = new Map(page.fields.map((field) => [field.id, field]));
  const unresolved = fields.find((field) => {
    const control = byId.get(field.controlId);
    return control && field.treatment !== 'auto-fill' && needsStudent(control, field.classification);
  });
  if (!unresolved) return undefined;
  return unresolved.classification === 'sensitive' || unresolved.classification === 'voluntary-self-identification'
    ? 'sensitive-question'
    : 'unresolved-field';
}

function needsStudent(field: GreenhouseField, classification: GreenhouseFieldPlan['classification']) {
  return field.visible && field.enabled && !field.completed
    && (field.required || classification === 'sensitive' || classification === 'voluntary-self-identification');
}
