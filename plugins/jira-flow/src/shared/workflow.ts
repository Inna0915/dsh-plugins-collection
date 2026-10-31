import type { Transition } from '../types.js';
export function requiresTransitionInput(transition: Transition): boolean {
  return Object.values(transition.fields).some((field) => field.required);
}
