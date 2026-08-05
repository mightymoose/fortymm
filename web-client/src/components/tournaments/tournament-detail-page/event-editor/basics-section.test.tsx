import userEvent from '@testing-library/user-event'

import { fireEvent, screen } from '@/test/utilities'

import { parseDrawTypeCatalogue } from '../../data/draw-types'
import {
  buildDrawnEvent,
  buildEvent,
  buildRrThenKoEvent,
  buildSwissEvent,
} from '../../data/seed.factory'
import { basicsSectionPage } from './basics-section.page'

describe('BasicsSection', () => {
  /**
   * ADR 20260726: the draw types a director is offered are **the rows the server sent**
   * (`draw_type_catalogue`), not a list this client keeps. `DRAW_TYPE_OPTIONS` — two
   * hardcoded entries with copy of their own — is deleted, and this is what replaces
   * the pin that used to guard it.
   *
   * ⚠️ These tests deliberately do NOT assert "the picker offers Round robin and Single
   * elimination". That passes just as happily against a hardcoded list, and would have
   * proved nothing about where the options came from. Each one hands the section a
   * catalogue that **differs from the seed** — renamed, reordered, or one row short —
   * and asserts the picker followed it.
   */
  describe('the draw-type picker (the rows the server sent)', () => {
    it('offers the served options, labelled and ordered as the server sent them', async () => {
      // Neither the seeded labels nor the seeded order — and not alphabetical either,
      // so a picker sorting on its own would fail too.
      basicsSectionPage.render({
        drawTypes: [
          { value: 'single-elim', label: 'Knockout bracket' },
          { value: 'round-robin', label: 'Everyone plays everyone' },
        ],
      })

      expect(await basicsSectionPage.openDrawTypeOptions()).toEqual([
        'Knockout bracket',
        'Everyone plays everyone',
      ])
    })

    /**
     * …and the other direction, which is the one that fails **silently** (#1227, ADR
     * "rr-then-ko cuts both stages upfront and seeds qualifiers rematch-free", Context).
     * The catalogue parser filters the served rows against `DRAW_TYPES`, a hardcoded slug
     * allowlist, and *drops* a slug that is not in it — no error, no warning, just an
     * absent option. So "seed the row and the picker follows" was predicted to need no
     * client change and would instead have shown a director two formats out of three.
     *
     * ⚠️ This test hands the section **wire rows** run through the real
     * `parseDrawTypeCatalogue`, not an option list. That is the whole point: a test given
     * ready-made options bypasses the filter and stays green with the slug taken back out
     * of the allowlist — which is precisely the defect.
     */
    it('offers a draw type the SERVER seeds, rather than dropping it silently', async () => {
      basicsSectionPage.render({
        drawTypes:
          parseDrawTypeCatalogue([
            {
              key: 'round-robin',
              name: 'Round robin',
              description: 'Everyone in a pool plays everyone else in that pool.',
              display_order: 1,
            },
            {
              key: 'rr-then-ko',
              name: 'Round-robin then knockout',
              description:
                'Pools play all-play-all, then the top finishers from each pool ' +
                'meet in a knockout bracket.',
              display_order: 3,
            },
          ]) ?? [],
      })

      expect(await basicsSectionPage.openDrawTypeOptions()).toEqual([
        'Round robin',
        'Round-robin then knockout',
      ])
    })

    /** …and picking it emits the **slug**, so the option the parser let through is one
     * the PATCH can actually carry. An allowlist that offered a word it could not send
     * would have moved the failure from the menu to the save. */
    it('emits the slug of a newly-seeded draw type', async () => {
      const onChange = vi.fn()
      basicsSectionPage.render({
        event: buildEvent({ drawType: 'round-robin' }),
        drawTypes: [
          { value: 'round-robin', label: 'Round robin' },
          { value: 'rr-then-ko', label: 'Round-robin then knockout' },
        ],
        onChange,
      })

      await basicsSectionPage.chooseDrawType('Round-robin then knockout')

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ drawType: 'rr-then-ko' }),
      )
    })

    /** The point of serving the catalogue: a format the server does not offer cannot be
     * chosen. Withhold single-elim and the bracket is simply not on the menu — the
     * director never gets to click it and meet a 422 four steps later. */
    it('cannot offer a draw type the server withheld', async () => {
      basicsSectionPage.render({
        event: buildEvent({ drawType: 'round-robin' }),
        drawTypes: [{ value: 'round-robin', label: 'Round robin' }],
      })

      expect(await basicsSectionPage.openDrawTypeOptions()).toEqual([
        'Round robin',
      ])
      expect(screen.queryByRole('option', { name: /elimination/i })).toBeNull()
    })

    /** The label is the server's; the **wire value is still the slug**. Picking an
     * option whose words the server chose must still emit `draw_type: 'single-elim'`,
     * or the catalogue would have bought a menu and lost a payload. */
    it('emits the slug, whatever the server calls it', async () => {
      const onChange = vi.fn()
      basicsSectionPage.render({
        event: buildEvent({ drawType: 'round-robin' }),
        drawTypes: [
          { value: 'round-robin', label: 'Everyone plays everyone' },
          { value: 'single-elim', label: 'Knockout bracket' },
        ],
        onChange,
      })

      await basicsSectionPage.chooseDrawType('Knockout bracket')

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ drawType: 'single-elim' }),
      )
    })

    /** The read-only half reads the same catalogue as the picker (ADR-0015: a viewer
     * gets a value, never a disabled control). Rename the row and the *viewer's* words
     * change with it — proof the two halves are one lookup, not two copies. */
    it('reads a viewer the served label for the stored slug', () => {
      basicsSectionPage.render({
        event: buildEvent({ drawType: 'single-elim' }),
        drawTypes: [{ value: 'single-elim', label: 'Knockout bracket' }],
        canEdit: false,
      })

      expect(basicsSectionPage.getFieldValue('Draw type')).toHaveTextContent(
        'Knockout bracket',
      )
    })

    /** No catalogue reached this surface. The row must not fall back to the stored
     * slug — an enum key is not a thing anyone reads, and `round-robin` on screen is
     * exactly the defect `labelFor` exists to prevent. An em-dash says "unknown". */
    it('never falls back to the raw slug when the catalogue is missing', () => {
      basicsSectionPage.render({
        event: buildEvent({ drawType: 'round-robin' }),
        drawTypes: [],
        canEdit: false,
      })

      expect(basicsSectionPage.getFieldValue('Draw type')).toHaveTextContent('—')
      expect(screen.queryByText('round-robin')).toBeNull()
    })
  })

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

  /**
   * **K** — the qualifier count (ADR 20260727). Its whole design is that it belongs to
   * the `(draw_type, K)` PAIR and not to the event: the server parses the two into a
   * union tagged by the draw type, whose `rr-then-ko` arm requires a count and whose
   * other two arms are `extra="forbid"` and refuse the key outright.
   *
   * So the claim worth pinning is not "there is a number box" — it is that the box is
   * **on screen for exactly one draw type**, and absent (not disabled, not em-dashed) for
   * the rest. A control rendered unconditionally would invite a director to answer a
   * question their event cannot hold the answer to, and would author a 422.
   */
  describe('the qualifier count (rr-then-ko only)', () => {
    it('renders the control for a two-stage event', () => {
      basicsSectionPage.render({ event: buildRrThenKoEvent({ qualifiersPerPool: 2 }) })

      expect(basicsSectionPage.getQualifiersInput()).toHaveValue(2)
    })

    // The falsification for the conditional: render it unconditionally and these red.
    it.each(['round-robin', 'single-elim'] as const)(
      'does not render it at all for %s — a format with no knockout stage to qualify for',
      (drawType) => {
        basicsSectionPage.render({
          event: buildEvent({ drawType, qualifiersPerPool: null }),
        })

        expect(basicsSectionPage.queryQualifiersInput()).toBeNull()
        // …and the rest of the tab is untouched, so this is "one row is absent" rather
        // than "the section failed to render".
        expect(basicsSectionPage.getNameInput()).toBeInTheDocument()
        expect(basicsSectionPage.getDrawTypeTrigger()).toBeInTheDocument()
      },
    )

    // Switching the picker is what a director actually does, and the row has to follow
    // the DRAFT they are building, not the event as it was loaded. (The editor bridges
    // live form state into `event`, so this is the same value that reaches the section;
    // the picker-driven version of this claim is in `event-editor.test.tsx`.)
    //
    // ⚠️ `rerenderWith`, never a second `render`: Testing Library APPENDS a second tree
    // rather than replacing the first, and `screen` spans the whole body — so a second
    // `render` leaves the old rr-then-ko section mounted and "the control is gone" fails
    // against a component that unmounts it correctly. Measured while writing this: two
    // renders → 2 `basics-section` roots and the stale input still found; one
    // `rerenderWith` → 1 root and 0 inputs.
    it('appears and disappears with the draw type the director picks', () => {
      const { rerenderWith } = basicsSectionPage.render({
        event: buildRrThenKoEvent({ qualifiersPerPool: 2 }),
      })
      expect(basicsSectionPage.getQualifiersInput()).toBeInTheDocument()

      rerenderWith({
        event: buildRrThenKoEvent({ drawType: 'round-robin', qualifiersPerPool: null }),
      })

      expect(basicsSectionPage.queryQualifiersInput()).toBeNull()
      // One tree, so the absence above is a real unmount and not a query that missed.
      expect(screen.getAllByTestId('basics-section')).toHaveLength(1)
    })

    it('emits the typed count', () => {
      const onChange = vi.fn()
      basicsSectionPage.render({
        event: buildRrThenKoEvent({ qualifiersPerPool: 2 }),
        onChange,
      })

      fireEvent.change(basicsSectionPage.getQualifiersInput(), {
        target: { value: '3' },
      })

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ qualifiersPerPool: 3 }),
      )
    })

    // Blank is **missing**, not zero — `Number('')` is `0`, and a bracket nobody advances
    // into is not what an emptied box means. The resolver turns the `null` into the
    // required error; a `0` would sail past a "did they answer?" check and be refused
    // later, by the server, in Pydantic's words.
    it('emits null — never 0 — when the box is cleared', () => {
      const onChange = vi.fn()
      basicsSectionPage.render({
        event: buildRrThenKoEvent({ qualifiersPerPool: 2 }),
        onChange,
      })

      fireEvent.change(basicsSectionPage.getQualifiersInput(), {
        target: { value: '' },
      })

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ qualifiersPerPool: null }),
      )
    })

    it('prints the form’s message under the box, and marks it invalid', () => {
      basicsSectionPage.render({
        event: buildRrThenKoEvent(),
        errors: {
          qualifiersPerPool: 'At least 1 player must advance from each pool.',
        },
      })

      expect(basicsSectionPage.getQualifiersInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(
        basicsSectionPage.queryFieldError(
          'At least 1 player must advance from each pool.',
        ),
      ).toBeInTheDocument()
    })

    // The count rides the SAME freeze as the draw type, because on the server it is the
    // same guard: `_enforce_draw_settings_frozen` compares the whole configuration, since
    // a bracket cut for `P × K` is exactly as contradicted by a changed K as by a changed
    // type. A live box here would author a 409.
    it('freezes with the draw type once the draw is cut, pointing at the reason', () => {
      basicsSectionPage.render({
        event: buildRrThenKoEvent({
          fixtures: buildDrawnEvent().fixtures,
        }),
      })

      const input = basicsSectionPage.getQualifiersInput()
      expect(input).toBeDisabled()
      const describedBy = input.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(document.getElementById(describedBy!)).toHaveTextContent(
        /Delete the draw/i,
      )
    })

    it('leaves it live, with its hint, when no draw is cut', () => {
      basicsSectionPage.render({ event: buildRrThenKoEvent() })

      expect(basicsSectionPage.getQualifiersInput()).toBeEnabled()
      expect(
        basicsSectionPage.queryFieldError(/advance to the knockout stage/i),
      ).toBeInTheDocument()
    })
  })

  /**
   * **R** — the round count (ADR "swiss pre-cuts every round and pairs each one on
   * advance"). Its design is the qualifier count's, one draw type over: it belongs to the
   * `(draw_type, R)` PAIR and not to the event, because the server parses the two into a
   * union tagged by the draw type, whose `swiss` arm requires a count and whose other three
   * arms are `extra="forbid"` and refuse the key outright.
   *
   * So the claim worth pinning is not "there is a number box" — it is that the box is **on
   * screen for exactly one draw type**, and absent (not disabled, not em-dashed) for the
   * rest. A control rendered unconditionally would invite a director to say how many rounds
   * a knockout bracket plays, and would author a 422.
   */
  describe('the round count (swiss only)', () => {
    it('renders the control for a swiss event', () => {
      basicsSectionPage.render({ event: buildSwissEvent({ rounds: 5 }) })

      expect(basicsSectionPage.getRoundsInput()).toHaveValue(5)
    })

    // The falsification for the conditional: render it unconditionally and these red.
    it.each(['round-robin', 'single-elim', 'rr-then-ko'] as const)(
      'does not render it at all for %s — a format whose rounds nobody chooses',
      (drawType) => {
        basicsSectionPage.render({
          event: buildEvent({
            drawType,
            rounds: null,
            qualifiersPerPool: drawType === 'rr-then-ko' ? 2 : null,
          }),
        })

        expect(basicsSectionPage.queryRoundsInput()).toBeNull()
        // …and the rest of the tab is untouched, so this is "one row is absent" rather
        // than "the section failed to render".
        expect(basicsSectionPage.getNameInput()).toBeInTheDocument()
        expect(basicsSectionPage.getDrawTypeTrigger()).toBeInTheDocument()
      },
    )

    // ⚠️ `rerenderWith`, never a second `render` — see the qualifier count's twin of this
    // test for the measurement behind that.
    it('appears and disappears with the draw type the director picks', () => {
      const { rerenderWith } = basicsSectionPage.render({
        event: buildSwissEvent({ rounds: 5 }),
      })
      expect(basicsSectionPage.getRoundsInput()).toBeInTheDocument()

      rerenderWith({
        event: buildSwissEvent({ drawType: 'round-robin', rounds: null }),
      })

      expect(basicsSectionPage.queryRoundsInput()).toBeNull()
      // One tree, so the absence above is a real unmount and not a query that missed.
      expect(screen.getAllByTestId('basics-section')).toHaveLength(1)
    })

    it('emits the typed round count', () => {
      const onChange = vi.fn()
      basicsSectionPage.render({ event: buildSwissEvent({ rounds: 5 }), onChange })

      fireEvent.change(basicsSectionPage.getRoundsInput(), {
        target: { value: '7' },
      })

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ rounds: 7 }),
      )
    })

    // Blank is **missing**, not zero — `Number('')` is `0`, and a swiss that plays no
    // rounds is not what an emptied box means. The resolver turns the `null` into the
    // required error; a `0` would sail past a "did they answer?" check and be refused
    // later, by the server, in Pydantic's words.
    it('emits null — never 0 — when the box is cleared', () => {
      const onChange = vi.fn()
      basicsSectionPage.render({ event: buildSwissEvent({ rounds: 5 }), onChange })

      fireEvent.change(basicsSectionPage.getRoundsInput(), {
        target: { value: '' },
      })

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ rounds: null }),
      )
    })

    it('prints the form’s message under the box, and marks it invalid', () => {
      basicsSectionPage.render({
        event: buildSwissEvent({ rounds: null }),
        errors: { rounds: 'Say how many rounds this event plays.' },
      })

      expect(basicsSectionPage.getRoundsInput()).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(
        basicsSectionPage.queryFieldError('Say how many rounds this event plays.'),
      ).toBeInTheDocument()
    })

    // The round count rides the SAME freeze as the draw type, because on the server it is
    // the same guard: `_enforce_draw_settings_frozen` compares the whole configuration,
    // since a draw cut as `R × ⌊n/2⌋` fixtures is exactly as contradicted by a changed R as
    // by a changed type. A live box here would author a 409.
    it('freezes with the draw type once the draw is cut, pointing at the reason', () => {
      basicsSectionPage.render({
        event: buildSwissEvent({ fixtures: buildDrawnEvent().fixtures }),
      })

      const input = basicsSectionPage.getRoundsInput()
      expect(input).toBeDisabled()
      const describedBy = input.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(document.getElementById(describedBy!)).toHaveTextContent(
        /Delete the draw/i,
      )
    })

    it('leaves it live, with its hint, when no draw is cut', () => {
      basicsSectionPage.render({ event: buildSwissEvent() })

      expect(basicsSectionPage.getRoundsInput()).toBeEnabled()
      expect(
        basicsSectionPage.queryFieldError(/Nobody is eliminated/i),
      ).toBeInTheDocument()
    })

    // A reader gets the number as TEXT, never a disabled spinner (ADR-0015).
    it('reads a viewer the stored round count, with no control at all', () => {
      basicsSectionPage.render({
        event: buildSwissEvent({ rounds: 5 }),
        canEdit: false,
      })

      expect(basicsSectionPage.getRoundsValue()).toHaveTextContent('5')
      expect(basicsSectionPage.queryRoundsInput()).toBeNull()
    })
  })

  it('shows the event name and format', () => {
    basicsSectionPage.render({
      event: buildEvent({ name: 'Open Singles', format: 'singles' }),
    })
    expect(basicsSectionPage.getNameInput()).toHaveValue('Open Singles')
    expect(basicsSectionPage.getFormatTrigger()).toHaveTextContent('Singles')
  })

  // The timezone anchors the wall-clock windows (ADR 20260719): the picker carries
  // the event's zone, and the caption beside the Time slot labels the frame those
  // times are read in.
  it('shows the event timezone on the picker and beside the window', () => {
    basicsSectionPage.render({
      event: buildEvent({ timezone: 'America/Denver' }),
    })
    expect(basicsSectionPage.getTimezoneTrigger()).toHaveTextContent(
      'America/Denver',
    )
    expect(basicsSectionPage.getTimezoneLabel()).toHaveTextContent(
      'America/Denver',
    )
  })

  // Picking a zone emits the whole event with the new timezone, through the same
  // `onChange` every other Basics field writes back through.
  it('emits the chosen timezone', async () => {
    const onChange = vi.fn()
    basicsSectionPage.render({
      event: buildEvent({ timezone: 'America/Chicago' }),
      onChange,
    })
    const user = userEvent.setup()
    await user.click(basicsSectionPage.getTimezoneTrigger())
    await user.type(
      await screen.findByPlaceholderText('Search timezones…'),
      'Denver',
    )
    await user.click(await screen.findByRole('option', { name: 'America/Denver' }))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: 'America/Denver' }),
    )
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

    // …and the same sweep over the ONE draw type that renders an extra row. The default
    // fixture is round-robin, whose qualifier-count row is not rendered at all — so the
    // guard above passes whether or not that row honours `readOnly`, and a live
    // `<input type=number>` (a `spinbutton`, invisible to a role-only sweep) could ship
    // behind it. The DOM sweep over a two-stage event is what actually covers it.
    it('renders no interactive controls for a two-stage event either', () => {
      basicsSectionPage.render({
        event: buildRrThenKoEvent({ qualifiersPerPool: 2 }),
        canEdit: false,
      })

      expect(basicsSectionPage.getFormElements()).toHaveLength(0)
      expect(basicsSectionPage.queryQualifiersInput()).toBeNull()
      // The value is still THERE — a viewer reads the count, they just cannot type it.
      // (`Field` requires a `value` beside `readOnly` precisely so a row cannot vanish
      // into an em-dash and be mistaken for one the organizer left blank.)
      expect(basicsSectionPage.getQualifiersValue()).toHaveTextContent('2')
    })

    // …and the same sweep over the OTHER draw type that renders an extra row. The two
    // guards above are both blind to it: the default fixture is round-robin and the
    // two-stage one renders the qualifier count, so neither ever mounts the swiss branch —
    // and a live `<input type=number>` there is a `spinbutton`, which a role-only sweep
    // does not see at all (`web-client/CLAUDE.md`). The DOM sweep over a swiss event is
    // what actually covers it.
    it('renders no interactive controls for a swiss event either', () => {
      basicsSectionPage.render({
        event: buildSwissEvent({ rounds: 5 }),
        canEdit: false,
      })

      expect(basicsSectionPage.getFormElements()).toHaveLength(0)
      expect(basicsSectionPage.queryRoundsInput()).toBeNull()
      // The value is still THERE — a viewer reads the round count, they just cannot type
      // it.
      expect(basicsSectionPage.getRoundsValue()).toHaveTextContent('5')
    })

    it('renders every field as a value', () => {
      basicsSectionPage.render({
        event: buildEvent({
          name: 'Open Singles',
          format: 'doubles',
          drawType: 'single-elim',
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
        'Single elimination',
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

    // The timezone is a fact about the event a reader is owed too (ADR 20260719) —
    // as text, never a live picker (which would be a control leak the guard forbids).
    it('renders the timezone as text, with its caption', () => {
      basicsSectionPage.render({
        event: buildEvent({ timezone: 'America/New_York' }),
        canEdit: false,
      })
      expect(basicsSectionPage.getFieldValue('Timezone')).toHaveTextContent(
        'America/New_York',
      )
      expect(basicsSectionPage.getTimezoneLabel()).toHaveTextContent(
        'America/New_York',
      )
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
