import { useState } from 'react'
import userEvent from '@testing-library/user-event'

import { render } from '@/test/utilities'

import { SettingRow } from './setting-row'
import { buildSettingRowProps } from './setting-row.factory'
import { settingRowPage } from './setting-row.page'

describe('SettingRow', () => {
  it('reads out the setting, what it means, what it says and where that came from', () => {
    settingRowPage.render()

    expect(settingRowPage.getName()).toHaveTextContent('Pool count')
    expect(settingRowPage.getHint()).toHaveTextContent(
      'How many pools the field splits into. Each pool also books its tables and time window.',
    )
    expect(settingRowPage.getValue()).toHaveTextContent('4')
    expect(settingRowPage.queryUnit()).toHaveTextContent('pools')
    expect(settingRowPage.getSource()).toHaveTextContent(
      "4 pool reservations · today's behaviour",
    )
  })

  // The row is addressable by the thing it sets, not by its position in the list — four
  // rows of identical markup are otherwise indistinguishable to a screen reader.
  it('names the region after the setting', () => {
    settingRowPage.render({ name: 'Qualifiers per pool' })

    expect(settingRowPage.getRow()).toHaveAccessibleName('Qualifiers per pool')
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

  // A row with neither an `entry` nor an `action` is what a READER sees, and it renders
  // no control at all — not a disabled one, which is the unexplained dead end ADR-0015
  // forbids. Swept by `@/test/read-only`, never by a selector re-typed here.
  it('renders no control at all without an entry or an action', () => {
    settingRowPage.render({ entry: undefined, action: undefined })

    expect(settingRowPage.getFormElements()).toHaveLength(0)
  })

  describe('the quiet text action', () => {
    it('offers the caller’s words, and calls back when pressed', async () => {
      const onClick = vi.fn()
      settingRowPage.render({ action: { label: 'Set myself', onClick } })

      expect(settingRowPage.getAction()).toHaveTextContent('Set myself')
      await userEvent.click(settingRowPage.getAction())

      expect(onClick).toHaveBeenCalledTimes(1)
    })

    // Three rows offer `Set myself`, so the visible words alone name no setting. The
    // button carries the row's name for a reader browsing by button.
    it('names the setting it acts on, for a screen reader', () => {
      settingRowPage.render({
        name: 'Qualifiers per pool',
        action: { label: 'Set myself', onClick: () => {} },
      })

      expect(settingRowPage.getAction()).toHaveAccessibleName(
        'Set myself Qualifiers per pool',
      )
    })
  })

  /**
   * The manual box. `<input type="text" inputMode="numeric">` and **no spinner** — the
   * reference is explicit that there are no plus or minus buttons anywhere, and a
   * `type="number"` would bring a scroll-wheel that silently changes a saved number.
   */
  describe('the direct-entry box', () => {
    const entry = (overrides: Partial<{ value: number | null }> = {}) => ({
      value: 6,
      max: 512,
      onChange: vi.fn(),
      ...overrides,
    })

    it('shows the director’s number, in a numeric text box', () => {
      settingRowPage.render({ entry: entry() })

      const box = settingRowPage.getInput()
      expect(box).toHaveValue('6')
      expect(box).toHaveAttribute('type', 'text')
      expect(box).toHaveAttribute('inputMode', 'numeric')
      // No spinner, and nothing to press: the row's only button is its action.
      expect(box).not.toHaveAttribute('type', 'number')
    })

    // The visible words to its left are its label, so the accessible name is what a
    // sighted director reads. A box labelled only by the unit after it would announce as
    // "pools", which is indistinguishable across three rows.
    it('is named by the setting it holds', () => {
      settingRowPage.render({ name: 'Pool size', entry: entry() })

      expect(settingRowPage.getInput()).toHaveAccessibleName('Pool size')
    })

    // One number, one place. A row showing the derived text AND the box would be showing
    // the same setting twice, and the two would drift the moment one was typed into.
    it('replaces the read-out value rather than sitting beside it', () => {
      settingRowPage.render({ entry: entry() })

      expect(settingRowPage.queryValue()).toBeNull()
      expect(settingRowPage.queryUnit()).toHaveTextContent('pools')
    })

    it('hands back a number the bounds admit', async () => {
      const onChange = vi.fn()
      settingRowPage.render({ entry: { value: null, max: 512, onChange } })

      await userEvent.type(settingRowPage.getInput(), '8')

      expect(onChange).toHaveBeenCalledWith(8)
    })

    // ⚠️ `Number('')` is `0`, and a `0` is a 422 — the exact silent authorship the
    // player-limit box shipped once already (ADR-0935).
    it('hands back null for a cleared box, never a zero', async () => {
      const onChange = vi.fn()
      settingRowPage.render({ entry: { value: 6, max: 512, onChange } })

      await userEvent.clear(settingRowPage.getInput())

      expect(onChange).toHaveBeenCalledWith(null)
      expect(onChange).not.toHaveBeenCalledWith(0)
    })

    // Dropped, not clamped: the system never silently changes a director's number (ADR
    // 20260808), so the box keeps the one they last chose and nothing is written.
    it('drops a keystroke that would author a number the server refuses', async () => {
      const onChange = vi.fn()
      settingRowPage.render({ entry: { value: 51, max: 512, onChange } })

      // 51 → 513, one past the server's ceiling.
      await userEvent.type(settingRowPage.getInput(), '3')

      expect(onChange).not.toHaveBeenCalled()
    })

    /**
     * ⚠️ Rendered against **real state**, unlike every other case here. A box whose
     * `value` prop never moves is restored by React after each keystroke, so "select all
     * and type 4" would read `64` however well the row behaved — the harness, not the
     * component, would be what the test measured. With the value round-tripping, `64` is
     * the genuine failure: the selection was not replaced.
     */
    it('lets the director select the value and replace it outright', async () => {
      const Editing = () => {
        const [value, setValue] = useState<number | null>(6)
        return (
          <SettingRow
            {...buildSettingRowProps({ entry: { value, max: 512, onChange: setValue } })}
          />
        )
      }
      render(<Editing />)

      // Select all, then type — the correction a spinner-less box has to support.
      // `keyboard`, not `type`: `type` clicks the box first, which would collapse the
      // very selection this is about.
      await userEvent.tripleClick(settingRowPage.getInput())
      await userEvent.keyboard('4')

      expect(settingRowPage.getInput()).toHaveValue('4')
    })
  })

  // Membership's, and only when it is hand-dealt: what placing entrants yourself costs.
  it('carries a note under the source when the caller gives one', () => {
    settingRowPage.render({
      note: 'Repeat protection turns off when you assign pools by hand.',
    })

    expect(settingRowPage.queryNote()).toHaveTextContent(
      'Repeat protection turns off when you assign pools by hand.',
    )
  })

  it('has no note otherwise', () => {
    settingRowPage.render()

    expect(settingRowPage.queryNote()).toBeNull()
  })

  /**
   * The two things a row can say about why it is not simply working: the resolver's red,
   * and the reason it is frozen. They share one slot and the error outranks the freeze —
   * the same order the Basics row this pattern came from used, and the same reason: the
   * thing that is wrong outranks the thing that is merely worth knowing.
   */
  describe('the message slot', () => {
    it('says nothing when the value is accepted and the setting is open', () => {
      settingRowPage.render({ freeze: { kind: 'open' } })

      expect(settingRowPage.queryError()).toBeNull()
      expect(settingRowPage.queryFreezeReason()).toBeNull()
    })

    it('prints the resolver’s red, and marks the box invalid', () => {
      settingRowPage.render({
        entry: { value: null, max: 1000, onChange: vi.fn() },
        error: 'Say how many players advance from each pool.',
      })

      expect(settingRowPage.queryError()).toHaveTextContent(
        'Say how many players advance from each pool.',
      )
      const input = settingRowPage.getInput()
      expect(input).toHaveAttribute('aria-invalid', 'true')
      // POINTED at, not merely printed nearby — the channel a screen reader has.
      expect(settingRowPage.describedNodeOf(input)).toHaveTextContent(
        'Say how many players advance from each pool.',
      )
    })

    /**
     * A frozen row: the box and the action stay on screen, **disabled, with the reason**
     * (ADR 20260806). Not hidden — what changed is the state of the event, not who the
     * director is, and a control that vanishes from under somebody entitled to it asks a
     * loud question and answers none of it.
     *
     * The action is asserted too, and deliberately: on a cut event `Set myself` seeds the
     * box from the DERIVED count, so it writes K just as typing does. A freeze that left
     * it live would leave the 409 exactly one click away.
     */
    it('disables the box and the action, and points both at the reason', () => {
      settingRowPage.render({
        entry: { value: 2, max: 1000, onChange: vi.fn() },
        action: { label: 'Use automatic', onClick: vi.fn() },
        freeze: { kind: 'frozen', reason: 'The bracket was cut for the top 2.' },
      })

      const input = settingRowPage.getInput()
      const action = settingRowPage.getAction()
      expect(input).toBeDisabled()
      expect(action).toBeDisabled()
      expect(settingRowPage.queryFreezeReason()).toHaveTextContent(
        'The bracket was cut for the top 2.',
      )
      expect(settingRowPage.describedNodeOf(input)).toHaveTextContent(
        'The bracket was cut for the top 2.',
      )
      expect(settingRowPage.describedNodeOf(action)).toHaveTextContent(
        'The bracket was cut for the top 2.',
      )
    })

    // …and a frozen box takes no input, which is the whole point of the freeze. The
    // disabled attribute is what stops it, so this is the behaviour behind the attribute
    // rather than a second reading of it.
    it('writes nothing while frozen', async () => {
      const onChange = vi.fn()
      settingRowPage.render({
        entry: { value: 2, max: 1000, onChange },
        freeze: { kind: 'frozen', reason: 'The bracket was cut for the top 2.' },
      })

      await userEvent.type(settingRowPage.getInput(), '3')

      expect(onChange).not.toHaveBeenCalled()
    })

    // One slot, and the error wins it: a row cannot be both refused and frozen in
    // practice — a frozen row holds the value the draw was cut from, which the resolver
    // accepts — so the slot states the one that is actionable.
    it('shows the error rather than the freeze when both are given', () => {
      settingRowPage.render({
        entry: { value: null, max: 1000, onChange: vi.fn() },
        error: 'Say how many players advance from each pool.',
        freeze: { kind: 'frozen', reason: 'The bracket was cut for the top 2.' },
      })

      expect(settingRowPage.queryError()).toHaveTextContent(
        'Say how many players advance from each pool.',
      )
      expect(settingRowPage.queryFreezeReason()).toBeNull()
    })
  })
})
