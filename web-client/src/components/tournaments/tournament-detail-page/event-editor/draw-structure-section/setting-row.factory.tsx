import type { SettingRowProps } from './setting-row'

/**
 * The reference's **Group count** row in its "Nothing set" state
 * (`docs/designs/rr-then-ko-draw-structure/nothing-set.png`): four groups, derived from
 * four reservations, so every part of the row is populated — a numeric value, a
 * unit, an `Automatic` badge and a source sentence.
 *
 * The Membership row (no number, no unit) is built by overriding
 * `kind: 'phrase'` and dropping the unit.
 */
export function buildSettingRowProps(
  overrides: Partial<SettingRowProps> = {},
): SettingRowProps {
  return {
    name: 'Group count',
    hint: 'How many groups the field splits into. Each group’s reservation also books its tables and time window.',
    value: '4',
    kind: 'number',
    unit: 'groups',
    ownership: 'automatic',
    source: "4 reservations · today's behaviour",
    ...overrides,
  }
}
