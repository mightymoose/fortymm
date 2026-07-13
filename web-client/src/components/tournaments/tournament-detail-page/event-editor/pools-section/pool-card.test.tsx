import userEvent from '@testing-library/user-event'

import { fireEvent, screen } from '@/test/utilities'

import { buildPool } from '../../../data/seed.factory'
import { poolCardPage } from './pool-card.page'

describe('PoolCard', () => {
  it('marks the selected tables as pressed', () => {
    poolCardPage.render({ pool: buildPool({ tableIds: ['t1', 't2'] }) })
    expect(poolCardPage.getSelectedTableToggle('T1')).toBeInTheDocument()
    expect(poolCardPage.getTableToggle('T5')).toBeInTheDocument()
  })

  it('adds an unselected table on click', async () => {
    const onChange = vi.fn()
    poolCardPage.render({ pool: buildPool({ tableIds: ['t1'] }), onChange })
    await userEvent.click(poolCardPage.getTableToggle('T5'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: ['t1', 't5'] }),
    )
  })

  it('removes the pool', async () => {
    const onRemove = vi.fn()
    poolCardPage.render({ onRemove })
    await userEvent.click(poolCardPage.getRemoveButton())
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  // The pool-set freeze, at the level of one card (ADR-0786). The *reason* is not the
  // card's to say — the section says it once, above the cards — so what the card owes is
  // a dead button that points at it.
  describe('when the event’s draw is cut', () => {
    it('disables the remove button and points it at the reason', async () => {
      const onRemove = vi.fn()
      poolCardPage.render({
        removal: { kind: 'frozen', reasonId: 'freeze-notice' },
        onRemove,
      })

      const button = poolCardPage.getRemoveButton()
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-describedby', 'freeze-notice')
      // Disabled means disabled: the click is refused by the DOM, not merely styled away.
      await userEvent.click(button)
      expect(onRemove).not.toHaveBeenCalled()
    })

    // Disabled, not hidden — this is the case a director can get *out* of (delete the
    // draw), unlike the viewer's, whose buttons never come back. Hiding it would take
    // the way out with it.
    it('still renders the remove button', () => {
      poolCardPage.render({
        removal: { kind: 'frozen', reasonId: 'freeze-notice' },
      })
      expect(poolCardPage.queryRemoveButton()).toBeInTheDocument()
    })

    // The whole reason the freeze is scoped to identity: a table breaks and is pulled, a
    // pool slips an hour, a pool is renamed — all of it mid-event, none of it costing
    // the draw. A card that greyed itself out wholesale would break exactly this.
    it('leaves the name, the window and the table toggles live', async () => {
      const onChange = vi.fn()
      poolCardPage.render({
        pool: buildPool({ tableIds: ['t1'] }),
        removal: { kind: 'frozen', reasonId: 'freeze-notice' },
        onChange,
      })

      await userEvent.click(poolCardPage.getTableToggle('T5'))
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ tableIds: ['t1', 't5'] }),
      )

      fireEvent.change(poolCardPage.getNameInput(), {
        target: { value: 'Morning Pool' },
      })
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'Morning Pool' }),
      )

      fireEvent.change(screen.getByLabelText('End'), {
        target: { value: '13:15' },
      })
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          slot: expect.objectContaining({ end: '13:15' }),
        }),
      )
    })
  })

  describe('for a non-owner (read-only)', () => {
    // The guard test (ADR 0015, rule 6): a viewer gets a rendering of the data,
    // never a disabled editor. The DOM sweep, not a role sweep — this card's
    // window is three `type="date"` / `type="time"` inputs, and those carry no
    // ARIA role at all, so the four canonical roles would miss a live date row
    // entirely and go green with the whole window still editable.
    it('renders no interactive controls', () => {
      poolCardPage.render({ canEdit: false })
      // The DOM sweep first: it is the load-bearing one, so it is the one whose
      // red is worth seeing.
      expect(poolCardPage.getFormElements()).toHaveLength(0)
      expect(poolCardPage.getInteractiveControls()).toHaveLength(0)
    })

    it('reads the pool name as text, not a name box', () => {
      poolCardPage.render({
        pool: buildPool({ name: 'Pool A' }),
        canEdit: false,
      })
      expect(poolCardPage.getName()).toHaveTextContent('Pool A')
      expect(poolCardPage.queryNameInput()).toBeNull()
    })

    // The date reads in words, never as the `YYYY-MM-DD` the editor's
    // `<input type="date">` takes. The times have no such helper and stay raw
    // here, on the event card, and everywhere else.
    it('reads the window back under the same Date / Start / End labels', () => {
      poolCardPage.render({
        pool: buildPool({
          slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
        }),
        canEdit: false,
      })
      expect(poolCardPage.getFieldValue('Date')).toHaveTextContent(
        'Jun 13, 2026',
      )
      expect(poolCardPage.getFieldValue('Start')).toHaveTextContent('09:00')
      expect(poolCardPage.getFieldValue('End')).toHaveTextContent('12:30')
      expect(screen.queryByText('2026-06-13')).toBeNull()
    })

    // The reserved tables are the point of a pool. Read-only they are a list of
    // the very labels the toggles showed — no second vocabulary.
    it('lists the tables the pool reserves', () => {
      poolCardPage.render({
        pool: buildPool({ tableIds: ['t1', 't2', 't5'] }),
        canEdit: false,
      })
      expect(poolCardPage.getReservedTables()).toHaveTextContent('T1, T2, T5')
    })

    // Catalogue order, not the order the organizer happened to click them in.
    it('lists the tables in catalogue order', () => {
      poolCardPage.render({
        pool: buildPool({ tableIds: ['t5', 't1'] }),
        canEdit: false,
      })
      expect(poolCardPage.getReservedTables()).toHaveTextContent('T1, T5')
    })

    // A pool that reserves nothing is unset, not blank: an em-dash, so absent
    // stays distinguishable from not-applicable (ADR 0015, rule 3).
    it('reads a pool with no tables as an em-dash', () => {
      poolCardPage.render({ pool: buildPool({ tableIds: [] }), canEdit: false })
      expect(poolCardPage.getReservedTables()).toHaveTextContent('—')
    })

    // Hidden, never disabled: a disabled button is an unexplained dead end.
    it('hides the remove button', () => {
      poolCardPage.render({ canEdit: false })
      expect(poolCardPage.queryRemoveButton()).toBeNull()
    })
  })
})
