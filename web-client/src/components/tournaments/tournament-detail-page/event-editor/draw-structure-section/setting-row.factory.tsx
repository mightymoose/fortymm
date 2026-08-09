import type { SettingRowProps } from './setting-row'

/**
 * The reference's **Pool count** row in its "Nothing set" state
 * (`docs/designs/rr-then-ko-draw-structure/nothing-set.png`): four pools, derived from
 * four pool reservations, so every part of the row is populated — a numeric value, a
 * unit, an `Automatic` badge and a source sentence.
 *
 * The Membership row (no number, no unit) is built by overriding
 * `kind: 'phrase'` and dropping the unit.
 */
export function buildSettingRowProps(
  overrides: Partial<SettingRowProps> = {},
): SettingRowProps {
  return {
    name: 'Pool count',
    hint: 'How many pools the field splits into. Each pool also books its tables and time window.',
    value: '4',
    kind: 'number',
    unit: 'pools',
    ownership: 'automatic',
    source: "4 pool reservations · today's behaviour",
    ...overrides,
  }
}
