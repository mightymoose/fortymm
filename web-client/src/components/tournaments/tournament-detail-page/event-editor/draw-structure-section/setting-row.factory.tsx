import type { SettingRowProps } from './setting-row'

/**
 * The **Group count** row with nothing set: four groups, derived by dividing a
 * 20-player field by the default group size of five (#1386), so every part of the row
 * is populated — a numeric value, a unit, an `Automatic` badge and a source sentence.
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
    source: '20 players ÷ about 5 per group',
    ...overrides,
  }
}
