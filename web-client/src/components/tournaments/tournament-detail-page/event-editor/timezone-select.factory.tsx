import type { TimezoneSelectProps } from './timezone-select'

/** Props for `TimezoneSelect` — anchored on `America/Chicago`, the seed events'
 * zone, with a no-op `onChange` a test overrides with a spy. */
export function buildTimezoneSelectProps(
  overrides: Partial<TimezoneSelectProps> = {},
): TimezoneSelectProps {
  return {
    value: 'America/Chicago',
    ariaLabel: 'Timezone',
    onChange: () => {},
    ...overrides,
  }
}
