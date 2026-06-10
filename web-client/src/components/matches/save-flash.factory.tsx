import type { SaveFlashProps } from './save-flash'

/** Props for `SaveFlash` — by default, game 2's save just failed and the
 * dismiss callback is a spy-friendly no-op. */
export function buildSaveFlashProps(
  overrides: Partial<SaveFlashProps> = {},
): SaveFlashProps {
  return { gameNumber: 2, onDismiss: () => {}, ...overrides }
}
