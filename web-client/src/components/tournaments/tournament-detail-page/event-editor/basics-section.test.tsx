import { fireEvent, screen } from '@/test/utilities'

import { buildDrawnEvent, buildEvent } from '../../data/seed.factory'
import { basicsSectionPage } from './basics-section.page'

describe('BasicsSection', () => {
  // ADR-0786: the draw type is the strategy that DEALT the event's fixtures, so once a
  // draw exists it is frozen (the server 409s a change). The editor declines to build
  // that change — and says why, and how to undo the block, because a director who is
  // only stopped is stuck.
  describe('the draw type, once the draw is cut', () => {
    it('disables the select and says why, with the way out', () => {
      basicsSectionPage.render({ event: buildDrawnEvent() })

      // Still shown, and still readable — it is a fact about the event they came to
      // check. It just cannot be changed.
      const trigger = basicsSectionPage.getDrawTypeTrigger()
      expect(trigger).toBeDisabled()
      expect(trigger).toHaveTextContent('Round robin')

      // The reason lives in text under the control, because a disabled trigger holds no
      // tooltip a screen reader would ever read. It names the type the fixtures were
      // dealt as — in the select's own words, never `round-robin`.
      expect(
        screen.getByText(/its draw type is frozen/i),
      ).toHaveTextContent('“Round robin”')
      expect(screen.getByText(/Delete the draw to change the type/i)).toBeInTheDocument()
    })

    // …and the trigger POINTS at that reason. Rendering the sentence under the control
    // puts it *beside* the control on screen and nowhere at all in the accessibility
    // tree: a disabled trigger is not focusable and holds no tooltip, so
    // `aria-describedby` is the only channel it has left. The pools section one tab over
    // wired exactly this freeze correctly (`pools-frozen-notice`), while here the
    // `Field` hint had no `id` to point at and the trigger's description was `null` —
    // the same dead end, said out loud to sighted directors only.
    it('points the disabled select at the reason (aria-describedby)', () => {
      basicsSectionPage.render({ event: buildDrawnEvent() })

      const trigger = basicsSectionPage.getDrawTypeTrigger()
      const describedBy = trigger.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()

      // The id resolves to the element that really holds the reason — not merely to
      // *an* id (a dangling `aria-describedby` describes nothing, and is a WCAG
      // failure of its own).
      const description = document.getElementById(describedBy!)
      expect(description).toHaveTextContent(/its draw type is frozen/i)
      expect(description).toHaveTextContent(/Delete the draw to change the type/i)
    })

    it('leaves the select live when no draw is cut', () => {
      basicsSectionPage.render({ event: buildEvent() })

      expect(basicsSectionPage.getDrawTypeTrigger()).toBeEnabled()
      expect(screen.queryByText(/draw type is frozen/i)).toBeNull()
    })

    // The rest of the tab is untouched by the draw: a director renames an event, moves
    // its window and drops its fee mid-tournament, draw or no draw.
    it('leaves the other basics fields editable', () => {
      const onChange = vi.fn()
      basicsSectionPage.render({ event: buildDrawnEvent(), onChange })

      expect(basicsSectionPage.getNameInput()).toBeEnabled()
      fireEvent.change(basicsSectionPage.getEntryFeeInput(), {
        target: { value: '5' },
      })
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ entryFee: 5 }),
      )
    })
  })

  it('shows the event name and format', () => {
    basicsSectionPage.render({
      event: buildEvent({ name: 'Open Singles', format: 'singles' }),
    })
    expect(basicsSectionPage.getNameInput()).toHaveValue('Open Singles')
    expect(basicsSectionPage.getFormatTrigger()).toHaveTextContent('Singles')
  })

  it('emits a numeric player limit', () => {
    const onChange = vi.fn()
    basicsSectionPage.render({ event: buildEvent({ maxPlayers: 32 }), onChange })
    fireEvent.change(basicsSectionPage.getPlayerLimitInput(), {
      target: { value: '48' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ maxPlayers: 48 }),
    )
  })

  // Clearing the cap is "no cap" (ADR-0935), not `0`/`NaN` — the blank field
  // must emit `null`, so it round-trips to the API as `max_players: null`.
  it('emits a null player limit when the field is cleared', () => {
    const onChange = vi.fn()
    basicsSectionPage.render({ event: buildEvent({ maxPlayers: 64 }), onChange })
    fireEvent.change(basicsSectionPage.getPlayerLimitInput(), {
      target: { value: '' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ maxPlayers: null }),
    )
  })

  // Blank fee is *missing* (a required error upstream), marked here as `NaN` so
  // it can't be mistaken for a legitimate free event (`0`).
  it('emits NaN when the entry fee is cleared, and a real 0 when typed', () => {
    const onChange = vi.fn()
    basicsSectionPage.render({ event: buildEvent({ entryFee: 45 }), onChange })

    fireEvent.change(basicsSectionPage.getEntryFeeInput(), {
      target: { value: '' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ entryFee: NaN }),
    )

    onChange.mockClear()
    fireEvent.change(basicsSectionPage.getEntryFeeInput(), {
      target: { value: '0' },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ entryFee: 0 }),
    )
  })

  // The section renders the editor's form errors below the offending field.
  it('renders inline field errors passed from the form', () => {
    basicsSectionPage.render({
      event: buildEvent(),
      errors: {
        name: 'Event name must be 255 characters or fewer.',
        maxPlayers: 'Player limit must be at least 1, or blank for no cap.',
        entryFee: 'Entry fee is required.',
      },
    })
    expect(
      basicsSectionPage.queryFieldError(/255 characters or fewer/),
    ).toBeInTheDocument()
    expect(
      basicsSectionPage.queryFieldError(/at least 1, or blank for no cap/),
    ).toBeInTheDocument()
    expect(
      basicsSectionPage.queryFieldError(/Entry fee is required/),
    ).toBeInTheDocument()
  })

  // The furniture the *editor* keeps. Paired with the read-only case below, so
  // "a viewer sees no asterisk" cannot be satisfied by deleting the asterisk.
  it('marks the required fields and explains the player limit to the creator', () => {
    basicsSectionPage.render({ event: buildEvent() })
    expect(basicsSectionPage.getLabelText('Event name')).toContain('*')
    expect(basicsSectionPage.getLabelText('Format')).toContain('*')
    expect(basicsSectionPage.queryPlayerLimitHint()).toBeInTheDocument()
  })

  /**
   * The section does not decide what is wrong — the editor's one resolver does
   * (`eventSchema`) and hands each tab its share. What the section owes is that a
   * message it is given lands **under the control it is about**, in red, with the
   * control marked invalid (`CLAUDE.md`, `## Forms`). Nothing here is a toast, and
   * nothing here is a banner.
   */
  describe('the fields the server can refuse (#783 QA)', () => {
    it('marks the name invalid and prints its message', () => {
      basicsSectionPage.render({
        event: buildEvent({ name: '' }),
        errors: { name: 'Name is required.' },
      })
      expect(basicsSectionPage.getNameInput()).toHaveAttribute('aria-invalid', 'true')
      expect(basicsSectionPage.queryFieldError('Name is required.')).toBeInTheDocument()
    })

    it('replaces the player-limit HINT with its error, rather than stacking both', () => {
      // A cap of `0` — the one the organizer *typed*, not the blank one, which is a
      // valid uncapped event and carries no error at all (ADR-0935).
      basicsSectionPage.render({
        event: buildEvent({ maxPlayers: 0 }),
        errors: {
          maxPlayers: 'The player limit must be at least 1, or blank for no cap.',
        },
      })
      expect(basicsSectionPage.getPlayerLimitInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(
        basicsSectionPage.queryFieldError(
          'The player limit must be at least 1, or blank for no cap.',
        ),
      ).toBeInTheDocument()
      // The thing that is wrong outranks the thing that is merely worth knowing.
      expect(basicsSectionPage.queryPlayerLimitHint()).not.toBeInTheDocument()
    })

    it('marks the entry fee invalid and prints its message', () => {
      basicsSectionPage.render({
        event: buildEvent({ entryFee: -5 }),
        errors: { entryFee: 'The entry fee cannot be negative.' },
      })
      expect(basicsSectionPage.getEntryFeeInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(
        basicsSectionPage.queryFieldError('The entry fee cannot be negative.'),
      ).toBeInTheDocument()
    })

    /** ⚠️ The blank cap is **not** an error, so the section must not dress it as one:
     * the box is empty (never "0", never "NaN"), the control is not marked invalid,
     * and the hint that tells the organizer this is allowed is still there. */
    it('shows an uncapped event as an EMPTY, valid player limit — no zero, no red', () => {
      basicsSectionPage.render({ event: buildEvent({ maxPlayers: null }) })

      expect(basicsSectionPage.getPlayerLimitInput()).toHaveValue(null)
      expect(basicsSectionPage.getPlayerLimitInput()).toHaveAttribute(
        'aria-invalid',
        'false',
      )
      expect(basicsSectionPage.queryPlayerLimitHint()).toBeInTheDocument()
    })

    it('marks nothing invalid when it is given no issues', () => {
      basicsSectionPage.render({ event: buildEvent({ name: '' }) })
      expect(basicsSectionPage.getNameInput()).toHaveAttribute('aria-invalid', 'false')
      expect(basicsSectionPage.queryPlayerLimitHint()).toBeInTheDocument()
    })
  })

  describe('for a non-owner (read-only)', () => {
    // The guard test (ADR 0015): a viewer gets a rendering of the data, never a
    // disabled editor. It fails loudly the moment someone adds an ungated
    // control — which is the drift that produced the original bug.
    it('renders no interactive controls', () => {
      basicsSectionPage.render({ event: buildEvent(), canEdit: false })
      expect(basicsSectionPage.getInteractiveControls()).toHaveLength(0)
      expect(basicsSectionPage.getFormElements()).toHaveLength(0)
    })

    it('renders every field as a value', () => {
      basicsSectionPage.render({
        event: buildEvent({
          name: 'Open Singles',
          format: 'doubles',
          drawType: 'rr-then-ko',
          maxPlayers: 64,
          entryFee: 45,
          slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
        }),
        canEdit: false,
      })

      expect(basicsSectionPage.getFieldValue('Event name')).toHaveTextContent(
        'Open Singles',
      )
      // The option's label, not the raw enum key.
      expect(basicsSectionPage.getFieldValue('Format')).toHaveTextContent(
        'Doubles',
      )
      expect(basicsSectionPage.getFieldValue('Draw type')).toHaveTextContent(
        'RR → KO',
      )
      expect(basicsSectionPage.getFieldValue('Player limit')).toHaveTextContent(
        '64',
      )
      expect(basicsSectionPage.getFieldValue('Entry fee')).toHaveTextContent('45')
      expect(basicsSectionPage.getFieldValue('Date')).toHaveTextContent(
        'Jun 13, 2026',
      )
      expect(basicsSectionPage.getFieldValue('Start')).toHaveTextContent('09:00')
      expect(basicsSectionPage.getFieldValue('End')).toHaveTextContent('18:00')
    })

    // `YYYY-MM-DD` is what an `<input type="date">` wants, not what a person
    // reads — a viewer gets the date in the same words the event card that
    // opened this panel used. (The times have no such helper and stay raw
    // everywhere, card included.)
    it('reads the date in words, not as the wire format', () => {
      basicsSectionPage.render({
        event: buildEvent({
          slot: { date: '2026-07-01', start: '09:00', end: '13:00' },
        }),
        canEdit: false,
      })
      expect(basicsSectionPage.getFieldValue('Date')).toHaveTextContent(
        'Jul 1, 2026',
      )
      expect(screen.queryByText('2026-07-01')).toBeNull()
    })

    // A free event is a real value the organizer chose — it must not be
    // mistaken for an empty one.
    it('renders a zero entry fee as zero, not as unset', () => {
      basicsSectionPage.render({
        event: buildEvent({ entryFee: 0 }),
        canEdit: false,
      })
      expect(basicsSectionPage.getFieldValue('Entry fee')).toHaveTextContent('0')
    })

    // A cleared player limit is `null` (no cap, ADR-0935) and a cleared entry
    // fee is `NaN`; both are unset — an em-dash — never "NaN", and never 0.
    it('renders a cleared player limit and entry fee as an em-dash', () => {
      basicsSectionPage.render({
        event: buildEvent({ maxPlayers: null, entryFee: NaN }),
        canEdit: false,
      })
      expect(basicsSectionPage.getFieldValue('Player limit')).toHaveTextContent(
        '—',
      )
      expect(basicsSectionPage.getFieldValue('Entry fee')).toHaveTextContent('—')
      expect(screen.queryByText(/NaN/)).toBeNull()
    })

    // An unset window is absent, not zero-length.
    it('renders an empty time slot as em-dashes', () => {
      basicsSectionPage.render({
        event: buildEvent({ slot: { date: '', start: '', end: '' } }),
        canEdit: false,
      })
      expect(basicsSectionPage.getFieldValue('Date')).toHaveTextContent('—')
      expect(basicsSectionPage.getFieldValue('Start')).toHaveTextContent('—')
      expect(basicsSectionPage.getFieldValue('End')).toHaveTextContent('—')
    })

    // The editor's subtitle is an imperative addressed to an organizer; a
    // viewer is not one (ADR 0015, rule 5).
    it('addresses the reader, not the organizer', () => {
      basicsSectionPage.render({ event: buildEvent(), canEdit: false })
      expect(screen.getByText('Format, entry and schedule.')).toBeInTheDocument()
      expect(screen.queryByText(/Name it, decide the format/)).toBeNull()
    })

    // The form's *furniture*, not just its controls (ADR 0015). A hint explains
    // how to fill in a control and an asterisk marks one you must complete —
    // both are nonsense on a field nobody can edit. `Field` drops them; the
    // labels themselves stay, because the row still names its value.
    it('renders no required asterisk and no hint', () => {
      basicsSectionPage.render({ event: buildEvent(), canEdit: false })

      expect(basicsSectionPage.getLabelText('Event name')).toBe('Event name')
      expect(basicsSectionPage.getLabelText('Format')).toBe('Format')
      expect(basicsSectionPage.queryPlayerLimitHint()).toBeNull()
      // Nothing anywhere in the section wears one.
      expect(screen.queryByText('*')).toBeNull()
    })
  })
})
