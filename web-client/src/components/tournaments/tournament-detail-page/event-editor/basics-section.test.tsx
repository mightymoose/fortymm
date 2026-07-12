import { fireEvent, screen } from '@/test/utilities'

import { buildEvent } from '../../data/seed.factory'
import { basicsSectionPage } from './basics-section.page'

describe('BasicsSection', () => {
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

  // The furniture the *editor* keeps. Paired with the read-only case below, so
  // "a viewer sees no asterisk" cannot be satisfied by deleting the asterisk.
  it('marks the required fields and explains the player limit to the creator', () => {
    basicsSectionPage.render({ event: buildEvent() })
    expect(basicsSectionPage.getLabelText('Event name')).toContain('*')
    expect(basicsSectionPage.getLabelText('Format')).toContain('*')
    expect(basicsSectionPage.queryPlayerLimitHint()).toBeInTheDocument()
  })

  /**
   * The section does not decide what is wrong — the editor does (`eventIssues`) and
   * hands each tab its share. What the section owes is that a message it is given
   * lands **under the control it is about**, in red, with the control marked invalid
   * (`CLAUDE.md`, `## Forms`). Nothing here is a toast, and nothing here is a banner.
   */
  describe('the fields the server can refuse (#783 QA)', () => {
    it('marks the name invalid and prints its message', () => {
      basicsSectionPage.render({
        event: buildEvent({ name: '' }),
        issues: { name: 'Name is required.' },
      })
      expect(basicsSectionPage.getNameInput()).toHaveAttribute('aria-invalid', 'true')
      expect(basicsSectionPage.queryFieldError('Name is required.')).toBeInTheDocument()
    })

    it('replaces the player-limit HINT with its error, rather than stacking both', () => {
      basicsSectionPage.render({
        event: buildEvent({ maxPlayers: Number('') }),
        issues: { maxPlayers: 'Enter a player limit.' },
      })
      expect(basicsSectionPage.getPlayerLimitInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(
        basicsSectionPage.queryFieldError('Enter a player limit.'),
      ).toBeInTheDocument()
      // The thing that is wrong outranks the thing that is merely worth knowing.
      expect(basicsSectionPage.queryPlayerLimitHint()).not.toBeInTheDocument()
    })

    it('marks the entry fee invalid and prints its message', () => {
      basicsSectionPage.render({
        event: buildEvent({ entryFee: -5 }),
        issues: { entryFee: 'The entry fee cannot be negative.' },
      })
      expect(basicsSectionPage.getEntryFeeInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(
        basicsSectionPage.queryFieldError('The entry fee cannot be negative.'),
      ).toBeInTheDocument()
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

    // `Number('')` is `NaN`, so a cleared numeric field reaches the view as NaN.
    // It is unset — an em-dash — never the literal string "NaN", and never 0.
    it('renders a cleared player limit and entry fee as an em-dash', () => {
      basicsSectionPage.render({
        event: buildEvent({ maxPlayers: NaN, entryFee: NaN }),
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
