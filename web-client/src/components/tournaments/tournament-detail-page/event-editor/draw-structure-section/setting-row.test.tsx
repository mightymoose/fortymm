import { settingRowPage } from './setting-row.page'

describe('SettingRow', () => {
  it('reads out the setting, what it means, what it says and where that came from', () => {
    settingRowPage.render()

    expect(settingRowPage.getName()).toHaveTextContent('Group count')
    expect(settingRowPage.getHint()).toHaveTextContent(
      'How many groups the field splits into. Each group’s reservation also books its tables and time window.',
    )
    expect(settingRowPage.getValue()).toHaveTextContent('4')
    expect(settingRowPage.queryUnit()).toHaveTextContent('groups')
    expect(settingRowPage.getSource()).toHaveTextContent(
      "4 reservations · today's behaviour",
    )
  })

  // The row is addressable by the thing it sets, not by its position in the list — four
  // rows of identical markup are otherwise indistinguishable to a screen reader.
  it('names the region after the setting', () => {
    settingRowPage.render({ name: 'Qualifiers per group' })

    expect(settingRowPage.getRow()).toHaveAccessibleName('Qualifiers per group')
  })

  // ADR 20260808: the owner is stated in WORDS. A badge that differed only by colour
  // would be no badge at all to a screen reader.
  it('says "Automatic" in text when the system owns the value', () => {
    settingRowPage.render({ ownership: 'automatic' })

    expect(settingRowPage.getOwnershipBadge()).toHaveTextContent('Automatic')
  })

  it('says "Yours" in text when the director owns the value', () => {
    settingRowPage.render({ ownership: 'manual' })

    expect(settingRowPage.getOwnershipBadge()).toHaveTextContent('Yours')
  })

  it('renders a figure in the mono face', () => {
    settingRowPage.render({ kind: 'number', value: '4' })

    expect(settingRowPage.getValue()).toHaveClass('font-mono')
  })

  // Membership: the value is prose, so there is no unit and no mono figure.
  it('renders a phrase with no unit and no mono face', () => {
    settingRowPage.render({
      name: 'Membership',
      kind: 'phrase',
      value: 'Snake automatically',
      unit: undefined,
      source: 'Seeds spread 1, 2, 3, 3, 2, 1.',
    })

    expect(settingRowPage.getValue()).toHaveTextContent('Snake automatically')
    expect(settingRowPage.getValue()).not.toHaveClass('font-mono')
    expect(settingRowPage.queryUnit()).toBeNull()
  })

  // This chore is read-only: the `Set myself` action and the numeric input are 3c, and
  // they are absent rather than disabled.
  it('renders no control — the value is text', () => {
    settingRowPage.render()

    expect(settingRowPage.getRow().querySelectorAll('input, button')).toHaveLength(
      0,
    )
  })
})
