export type FocusableApplicationField = {
  id: string;
  completed: boolean;
  visible: boolean;
  enabled: boolean;
  focusable: boolean;
};

/**
 * Focus advances only after a completed, editable field, and never lands on a
 * field the companion or user has already completed. Hidden controls and
 * non-text controls never receive an unexpected focus jump.
 */
export function nextFocusableApplicationField(
  fields: readonly FocusableApplicationField[],
  currentId: string,
) {
  const currentIndex = fields.findIndex((field) => field.id === currentId);
  if (currentIndex < 0 || !fields[currentIndex].completed) return undefined;
  return fields.slice(currentIndex + 1).find((field) =>
    !field.completed && field.visible && field.enabled && field.focusable,
  );
}
