import type { NearMeControlProps } from './near-me-control'

/** Props for `NearMeControl` — a no-op `onNearMeChange` by default, so a bare
 * `page.render()` mounts the toggle + radius picker with nothing wired. */
export function buildNearMeControlProps(
  overrides: Partial<NearMeControlProps> = {},
): NearMeControlProps {
  return {
    onNearMeChange: () => {},
    ...overrides,
  }
}
