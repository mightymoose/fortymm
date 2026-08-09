import userEvent from '@testing-library/user-event'

import { cleanup, fireEvent } from '@/test/utilities'

import { everySettingAutomatic } from '../../data/draw-ownership'
import { poolLetter } from '../../data/draw-structure'
import { keepPools } from '../../data/pool-entries'
import { buildPool } from '../../data/seed.factory'
import type { DrawOwnership, PoolEntry, TournamentEvent } from '../../data/types'
import { buildDrawStructureEvent } from './draw-structure-section.factory'
import { drawStructureSectionPage } from './draw-structure-section.page'

/** The "Nothing set" event with some of its settings already taken — the state a
 * director comes back to, and the one the round trip has to reproduce. */
const eventOwning = (
  taken: Partial<DrawOwnership>,
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
) =>
  buildDrawStructureEvent({
    drawOwnership: { ...everySettingAutomatic(), ...taken },
    ...overrides,
  })

/**
 * The reference's **"Field too small"** state
 * (`docs/designs/rr-then-ko-draw-structure/field-too-small-panel.png`): 8 players over
 * **six** pool reservations, which splits `2, 2, 1, 1, 1, 1`.
 *
 * The rows are lettered the way the tab letters them, because the fixes that reduce the
 * count name the reservations they would drop.
 */
const eventTooSmallForItsPools = (
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
) =>
  buildDrawStructureEvent({
    maxPlayers: 8,
    pools: Array.from({ length: 6 }, (_, i) =>
      buildPool({
        id: `p-${poolLetter(i).toLowerCase()}`,
        name: `Pool ${poolLetter(i)}`,
        position: i,
      }),
    ),
    ...overrides,
  })

/**
 * The reference's **"Numbers disagree"** state
 * (`docs/designs/rr-then-ko-draw-structure/numbers-disagree-panel.png`), and #1320's
 * required case: a field of **40** against **six** manual pools of **five** manual, which
 * seat thirty and leave ten entrants with nowhere to go.
 *
 * ⚠️ It keeps the "Nothing set" event's **four** pool rows, and that gap is deliberate: a
 * derived count in excess of the rows is reported, never materialised (ADR 20260808's point
 * 3). `Use 8 pools of 5` is the one act that closes it.
 */
const numbersDisagree = (overrides: Partial<Omit<TournamentEvent, 'entered'>> = {}) =>
  eventOwning(
    {
      poolCountMode: 'manual',
      manualPoolCount: 6,
      poolSizeMode: 'manual',
      manualPoolSize: 5,
    },
    { maxPlayers: 40, ...overrides },
  )

describe('DrawStructureSection', () => {
  it('says what the tab is for, in the reference’s words', () => {
    drawStructureSectionPage.render()

    expect(drawStructureSectionPage.getHeading()).toHaveTextContent(
      'Set what matters. We’ll work out the rest.',
    )
    expect(drawStructureSectionPage.getSection()).toHaveTextContent(
      'Pools play all-play-all. The top finishers move into a knockout bracket.',
    )
  })

  // The order is the reference's, and it is the order a director reads the draw in:
  // how many pools, how big, who is in them, how many come out.
  it('lists the four settings in order', () => {
    drawStructureSectionPage.render()

    expect(drawStructureSectionPage.getSettingNames()).toEqual([
      'Pool count',
      'Pool size',
      'Membership',
      'Qualifiers per pool',
    ])
  })

  /**
   * The reference's "Nothing set" state: 32 players over 4 pool reservations. Every
   * value AND every source sentence, because the sentence is what makes the number
   * checkable — `8` alone cannot tell a director whether the app divided their field or
   * invented a target.
   */
  describe('the reference’s "Nothing set" state — 32 players, 4 reservations', () => {
    it('derives 4 pools, and says the reservations are where that came from', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Pool count')
      expect(row.getValue()).toHaveTextContent('4')
      expect(row.queryUnit()).toHaveTextContent('pools')
      expect(row.getSource()).toHaveTextContent(
        "4 pool reservations · today's behaviour",
      )
    })

    it('derives 8 per pool, and shows the division it did', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Pool size')
      expect(row.getValue()).toHaveTextContent('8')
      expect(row.queryUnit()).toHaveTextContent('players per pool')
      expect(row.getSource()).toHaveTextContent('32 players ÷ 4 pools')
    })

    it('deals membership by snake, and says how the seeds spread', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Membership')
      expect(row.getValue()).toHaveTextContent('Snake automatically')
      expect(row.getSource()).toHaveTextContent('Seeds spread 1, 2, 3, 3, 2, 1.')
      // No number, so no unit — the value is already a sentence.
      expect(row.queryUnit()).toBeNull()
    })

    it('takes 2 through from each pool, aiming at the 8-player knockout', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Qualifiers per pool')
      expect(row.getValue()).toHaveTextContent('2')
      expect(row.queryUnit()).toHaveTextContent('through from each pool')
      expect(row.getSource()).toHaveTextContent(
        'Aiming at an 8-player knockout across 4 pools.',
      )
    })

    // ADR 20260808: the owner is readable as TEXT on every row, never as a shade.
    it('marks all four values Automatic, in words', () => {
      drawStructureSectionPage.render()

      for (const name of [
        'Pool count',
        'Pool size',
        'Membership',
        'Qualifiers per pool',
      ]) {
        expect(
          drawStructureSectionPage.setting(name).getOwnershipBadge(),
        ).toHaveTextContent('Automatic')
      }
    })
  })

  /**
   * **Taking a setting changes the owner, not the number** (ADR 20260808). The first
   * click seeds the box from what the row was already showing, so a director who wants to
   * nudge a number by one does not first have to work out what it currently is.
   *
   * Asserted on `onChange`, because that is the whole of the tab's write: the form is the
   * draft, and a tab holding state of its own would be a second one the save never read.
   */
  describe('taking a setting for yourself', () => {
    const takeSetting = async (name: string, event = buildDrawStructureEvent()) => {
      const onChange = vi.fn()
      drawStructureSectionPage.render({ event, onChange })

      await userEvent.click(drawStructureSectionPage.setting(name).getAction())

      return onChange
    }

    it('seeds the pool count from the count the row was showing', async () => {
      // 4 pool reservations, so the row reads 4 — and taking it types 4.
      const onChange = await takeSetting('Pool count')

      expect(onChange.mock.lastCall?.[0].drawOwnership).toEqual({
        ...everySettingAutomatic(),
        poolCountMode: 'manual',
        manualPoolCount: 4,
      })
    })

    /**
     * ⚠️ Deliberately an **uneven** field, and this is the case the seeding rule exists
     * for: 22 across 4 splits `6, 6, 5, 5`, so the largest pool is 6 and the smallest is
     * 5. On the even default fixture (32 across 4, every pool 8) the two are the same
     * number and a wrong rule would sail through.
     *
     * The largest is the target the split was aiming at. Seeding the smallest would
     * shrink the draw on the first click — the silent reshaping #1320 exists to remove.
     */
    it('seeds the pool size from the LARGEST derived pool, not the smallest', async () => {
      const onChange = await takeSetting(
        'Pool size',
        buildDrawStructureEvent({ maxPlayers: 22 }),
      )

      expect(onChange.mock.lastCall?.[0].drawOwnership).toEqual({
        ...everySettingAutomatic(),
        poolSizeMode: 'manual',
        manualPoolSize: 6,
      })
    })

    /**
     * The qualifier count has no manual slot of its own on the wire: **the event's K is
     * the slot**, and the mode says whether anybody should read it. So taking this
     * setting writes the event's own number — and writes the DERIVED one, which is what
     * the row, the preview and every pool card have been showing.
     *
     * Three pool reservations derive `ceil(8 / 3)` = 3, while the event stores 2. The two
     * numbers are different on purpose: a fixture where they agreed could not tell "the
     * derived count was written" from "nothing was written at all".
     */
    it('seeds the qualifier count onto the event’s own K', async () => {
      const onChange = await takeSetting(
        'Qualifiers per pool',
        buildDrawStructureEvent({
          qualifiersPerPool: 2,
          pools: [
            buildPool({ id: 'p-a', name: 'Pool A', position: 0 }),
            buildPool({ id: 'p-b', name: 'Pool B', position: 1 }),
            buildPool({ id: 'p-c', name: 'Pool C', position: 2 }),
          ],
        }),
      )

      const saved = onChange.mock.lastCall?.[0]
      expect(saved.qualifiersPerPool).toBe(3)
      expect(saved.drawOwnership.qualifiersMode).toBe('manual')
    })

    it('hands membership over without touching a number', async () => {
      const onChange = await takeSetting('Membership')

      expect(onChange.mock.lastCall?.[0].drawOwnership).toEqual({
        ...everySettingAutomatic(),
        membershipMode: 'manual',
      })
    })

    it('changes nothing else about the event', async () => {
      const event = buildDrawStructureEvent()
      const onChange = await takeSetting('Pool count', event)

      expect(onChange.mock.lastCall?.[0]).toEqual({
        ...event,
        drawOwnership: {
          ...everySettingAutomatic(),
          poolCountMode: 'manual',
          manualPoolCount: 4,
        },
      })
    })
  })

  /**
   * **Giving a setting back is not destructive.** `Use automatic` sets the mode and keeps
   * the number, so a director who looks at what the system would say and comes back gets
   * their own number returned rather than an empty box (ADR 20260808, and the API's own
   * comment on `DrawStructure`).
   */
  describe('giving a setting back', () => {
    it('keeps the director’s pool count, remembered, for the next time', async () => {
      const onChange = vi.fn()
      drawStructureSectionPage.render({
        event: eventOwning({ poolCountMode: 'manual', manualPoolCount: 6 }),
        onChange,
      })

      await userEvent.click(drawStructureSectionPage.setting('Pool count').getAction())

      expect(onChange.mock.lastCall?.[0].drawOwnership).toEqual({
        ...everySettingAutomatic(),
        poolCountMode: 'automatic',
        manualPoolCount: 6,
      })
    })

    /**
     * ⚠️ The qualifier count is the one that could be destroyed, because its value is the
     * event's own **required** K. Clearing it here would be both a destructive
     * `Use automatic` and an unsaveable event — the resolver refuses a two-stage event
     * with no count, and would send the director off to fix a number they never touched.
     */
    it('leaves the event’s K alone when qualifiers go back to automatic', async () => {
      const onChange = vi.fn()
      drawStructureSectionPage.render({
        event: eventOwning({ qualifiersMode: 'manual' }, { qualifiersPerPool: 3 }),
        onChange,
      })

      await userEvent.click(
        drawStructureSectionPage.setting('Qualifiers per pool').getAction(),
      )

      const saved = onChange.mock.lastCall?.[0]
      expect(saved.qualifiersPerPool).toBe(3)
      expect(saved.drawOwnership.qualifiersMode).toBe('automatic')
    })
  })

  /** What the tab looks like once a director owns a setting: a box instead of a figure,
   * `Yours` instead of `Automatic`, and a source sentence saying who set it. */
  describe('a setting the director owns', () => {
    it('reads the director’s number out of a box, and says it is theirs', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ poolCountMode: 'manual', manualPoolCount: 6 }),
      })

      const row = drawStructureSectionPage.setting('Pool count')
      expect(row.getInput()).toHaveValue('6')
      expect(row.getOwnershipBadge()).toHaveTextContent('Yours')
      expect(row.getSource()).toHaveTextContent(
        'You set this. Each pool also gets a reservation.',
      )
      expect(row.getAction()).toHaveTextContent('Use automatic')
    })

    it('offers a box on the size row too, and derives the count from it', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ poolSizeMode: 'manual', manualPoolSize: 5 }),
      })

      const row = drawStructureSectionPage.setting('Pool size')
      expect(row.getInput()).toHaveValue('5')
      expect(row.getSource()).toHaveTextContent(
        'You set the target. We derived the pool count.',
      )
      // 32 players in pools of 5 needs 7 pools, and the count row says so.
      expect(drawStructureSectionPage.setting('Pool count').getValue()).toHaveTextContent(
        '7',
      )
    })

    it('puts the event’s own K in the qualifiers box', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ qualifiersMode: 'manual' }, { qualifiersPerPool: 3 }),
      })

      const row = drawStructureSectionPage.setting('Qualifiers per pool')
      expect(row.getInput()).toHaveValue('3')
      expect(row.getSource()).toHaveTextContent('You set this.')
    })

    /**
     * ⚠️ The subtle state, and the reason the badge and the box read two different
     * things: a director can own a setting and have cleared its box. The derivation reads
     * that as automatic and reports the ownership it actually used, so the badge and the
     * source sentence can never disagree — while the box and the action follow the stored
     * mode, so the row stays theirs and can still be handed back.
     */
    it('reports the EFFECTIVE owner when the box is empty, and still offers it back', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ poolCountMode: 'manual', manualPoolCount: null }),
      })

      const row = drawStructureSectionPage.setting('Pool count')
      expect(row.getInput()).toHaveValue('')
      expect(row.getOwnershipBadge()).toHaveTextContent('Automatic')
      expect(row.getSource()).toHaveTextContent(
        "4 pool reservations · today's behaviour",
      )
      expect(row.getAction()).toHaveTextContent('Use automatic')
    })
  })

  /** Membership is the one setting with no number, so it is the one row that changes its
   * words rather than its figure. */
  describe('membership', () => {
    it('says the snake deals, and offers to hand it over', () => {
      drawStructureSectionPage.render()

      const row = drawStructureSectionPage.setting('Membership')
      expect(row.getValue()).toHaveTextContent('Snake automatically')
      expect(row.getSource()).toHaveTextContent('Seeds spread 1, 2, 3, 3, 2, 1.')
      expect(row.getAction()).toHaveTextContent('Assign myself')
      expect(row.queryNote()).toBeNull()
      // No number to own, so no box either.
      expect(row.queryInput()).toBeNull()
    })

    it('says the director will place the field, and what that costs', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ membershipMode: 'manual' }),
      })

      const row = drawStructureSectionPage.setting('Membership')
      expect(row.getValue()).toHaveTextContent('Assign at cut time')
      expect(row.getOwnershipBadge()).toHaveTextContent('Yours')
      expect(row.getSource()).toHaveTextContent(
        'You’ll place entrants once registration closes.',
      )
      expect(row.queryNote()).toHaveTextContent(
        'Repeat protection turns off when you assign pools by hand.',
      )
      expect(row.getAction()).toHaveTextContent('Use snake')
    })

    // The preview's fact follows the row, in the preview's own shorter words.
    it.each([
      ['snake', 'Snake'],
      ['manual', 'By hand at cut'],
    ] as const)('reports %s membership in the preview as "%s"', (mode, fact) => {
      drawStructureSectionPage.render({
        event: eventOwning({ membershipMode: mode }),
      })

      expect(
        drawStructureSectionPage.preview.getFact('Membership'),
      ).toHaveTextContent(fact)
    })
  })

  /**
   * **A cut draw freezes the qualifier count, and nothing else on this tab** (chore 3e,
   * the defect chore 3c surfaced).
   *
   * The knockout bracket is cut upfront for `P × K` and the qualifiers are seated into
   * predetermined slots as each pool finishes, so a K the fixtures were not cut for leaves
   * qualifiers with nowhere to sit — a 409 (`_qualifiers_per_pool_frozen_detail`). The
   * click that authored it looked harmless: `Set myself` seeds the box from the DERIVED
   * count, which on a cut event is routinely not the stored one.
   *
   * ⚠️ The **asymmetry is the point, and it is not symmetric on the server either.** The
   * other three settings' ownership modes are excluded from the server's freeze
   * (`configuration_the_draw_was_dealt_from`) because they size nothing the cut already put
   * on the table, so a director may still take the pool count on a cut event. Freezing the
   * whole tab would refuse work the server allows.
   */
  describe('a cut draw', () => {
    const FROZEN = {
      kind: 'frozen',
      reason: 'This event’s draw is cut, so the number of qualifiers per pool is frozen.',
    } as const

    it('disables the qualifier box and its action, and states why', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ qualifiersMode: 'manual' }),
        qualifiersFreeze: FROZEN,
      })

      const row = drawStructureSectionPage.setting('Qualifiers per pool')
      expect(row.getInput()).toBeDisabled()
      expect(row.getAction()).toBeDisabled()
      expect(row.queryFreezeReason()).toHaveTextContent(FROZEN.reason)
    })

    // `Use automatic` writes the MODE and nothing else, which the server permits outright —
    // so this row is frozen by the CLIENT's choice, not by a 409. It is refused because it
    // is a one-way door: hand the setting back and the row reports the derived count rather
    // than the one the bracket was cut for, and `Set myself` — the only way back — is
    // frozen. The comment on `qualifiersPerPoolFreeze` says so; this pins the behaviour.
    it('refuses even the mode flip on that row', async () => {
      const onChange = vi.fn()
      drawStructureSectionPage.render({
        event: eventOwning({ qualifiersMode: 'manual' }),
        qualifiersFreeze: FROZEN,
        onChange,
      })

      await userEvent.click(
        drawStructureSectionPage.setting('Qualifiers per pool').getAction(),
      )

      expect(onChange).not.toHaveBeenCalled()
    })

    // Pool count is NOT in this list, and it is not an omission: it freezes on a cut event
    // too, for a different reason and by a different freeze (the pool SET freeze — its row
    // now creates and removes pool rows). See `the pool set is frozen` below.
    it.each(['Pool size', 'Membership'])(
      'leaves %s alone — the server does not freeze its ownership',
      (name) => {
        drawStructureSectionPage.render({
          event: eventOwning({ qualifiersMode: 'manual' }),
          qualifiersFreeze: FROZEN,
        })

        const row = drawStructureSectionPage.setting(name)
        expect(row.getAction()).toBeEnabled()
        expect(row.queryFreezeReason()).toBeNull()
      },
    )
  })

  /**
   * **A pool count the director types IS a number of pool rows** (ADR
   * 20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-count-is-a-projection).
   * Nothing stores a second number, so typing `6` asks for six rows — created or removed
   * through the very list the Table pools tab edits and the save already sends.
   *
   * Asserted on the two writes together, because the ADR's demand is that they are one
   * act: the number and the rows change in one save, or neither does.
   */
  describe('typing a pool count', () => {
    /** The "Nothing set" event — **4 pool reservations** — with the count already taken,
     * so the row renders a box. */
    const owningFourPools = () =>
      eventOwning({ poolCountMode: 'manual', manualPoolCount: 4 })

    const renderOwningCount = (
      overrides: Parameters<typeof drawStructureSectionPage.render>[0] = {},
    ) => {
      const onChange = vi.fn()
      const onPoolsChange = vi.fn()
      drawStructureSectionPage.render({
        event: owningFourPools(),
        onChange,
        onPoolsChange,
        ...overrides,
      })
      return { onChange, onPoolsChange }
    }

    /** The box takes the whole value at once — a director correcting a count selects the
     * number and replaces it, and `acceptedManualEntry` reads what the box then holds.
     *
     * ⚠️ `fireEvent` rather than `userEvent.type` **at this level only**: these props are
     * spies, so nothing feeds a new `value` back into the controlled box, and typing would
     * append to the number already in it. The multi-digit claim is asserted where real
     * form state closes that loop — `event-editor.test.tsx`. */
    const typeCount = (value: string) =>
      fireEvent.change(drawStructureSectionPage.setting('Pool count').getInput(), {
        target: { value },
      })

    /** The director says they are done — they left the box. A *lowered* count is priced
     * here rather than on the keystroke, because `12` begins with `1`. */
    const finishTyping = () =>
      fireEvent.blur(drawStructureSectionPage.setting('Pool count').getInput())

    describe('raising it', () => {
      it('appends rows until the event has the count that was typed', () => {
        const { onChange, onPoolsChange } = renderOwningCount()

        typeCount('6')

        // ONE act: the stored number and the rows, written together.
        expect(onChange.mock.lastCall?.[0].drawOwnership.manualPoolCount).toBe(6)
        expect(onPoolsChange.mock.lastCall?.[0]).toHaveLength(6)
      })

      it('continues the letter sequence rather than restarting it', () => {
        const { onPoolsChange } = renderOwningCount()

        typeCount('6')

        expect(
          onPoolsChange.mock.lastCall?.[0].map((pool: PoolEntry) => pool.name),
        ).toEqual(['Pool A', 'Pool B', 'Pool C', 'Pool D', 'Pool E', 'Pool F'])
      })

      /** The director is not left completing a blank card: a new row runs when the last
       * one does. The factory's pools run 09:00–12:30 while the *event* runs 09:00–18:00,
       * so "the last pool's window" and "the event's window" are distinguishable here. */
      it('takes the last existing pool’s date and window, and reserves no tables', () => {
        const { onPoolsChange } = renderOwningCount()

        typeCount('5')

        const appended = onPoolsChange.mock.lastCall?.[0].at(-1)
        expect(appended.slot).toEqual({
          date: '2026-06-13',
          start: '09:00',
          end: '12:30',
        })
        // #1072 already reports an empty pool. A table selection the director never made
        // would be a reservation invented for them (ADR 20260808).
        expect(appended.tableIds).toEqual([])
      })

      /** ⚠️ `PoolWrite` is `extra="forbid"` and has no `id`, so a client-minted one is a
       * 422 naming the entry. The `added` arm is what makes that unsayable. */
      it('mints the new rows with no id, and leaves the stored ones citing theirs', () => {
        const { onPoolsChange } = renderOwningCount()

        typeCount('6')

        const written: PoolEntry[] = onPoolsChange.mock.lastCall?.[0]
        expect(written.slice(0, 4).map((pool) => pool.kind)).toEqual([
          'kept',
          'kept',
          'kept',
          'kept',
        ])
        expect(written.slice(4).map((pool) => pool.kind)).toEqual([
          'added',
          'added',
        ])
        expect(written.slice(4).every((pool) => !('id' in pool))).toBe(true)
      })

      /** Constructive: nothing is discarded, so nothing is priced (ADR 20260806 — the
       * first cut is exempt for the same reason). */
      it('asks no confirm', () => {
        renderOwningCount()

        typeCount('6')

        expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
      })
    })

    describe('lowering it', () => {
      /**
       * **Nothing is written on the keystroke.** Asserted with no query for the dialog in
       * it, deliberately: a test that reached for the dialog first would red with "unable
       * to find an alertdialog" the moment the confirm was removed, which cannot tell
       * "the write is gated" from "the dialog moved". This one reds on the write.
       */
      it('writes neither the count nor the rows until the removal is confirmed', () => {
        const { onChange, onPoolsChange } = renderOwningCount()

        typeCount('2')
        finishTyping()

        expect(onChange).not.toHaveBeenCalled()
        expect(onPoolsChange).not.toHaveBeenCalled()
      })

      /**
       * ⚠️ **A lowered count is not priced until the director has finished typing it**,
       * and this is the assertion that says why. Against four pools, `12` produces the
       * value `1` first; a confirm on that keystroke traps focus in a modal dialog and the
       * `2` never lands. The box shows what was typed and holds it.
       */
      it('holds a lower keystroke without pricing it, so a longer number can still be typed', () => {
        const { onChange, onPoolsChange } = renderOwningCount()

        typeCount('1')

        expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
        expect(drawStructureSectionPage.setting('Pool count').getInput()).toHaveValue('1')
        expect(onChange).not.toHaveBeenCalled()
        expect(onPoolsChange).not.toHaveBeenCalled()
      })

      /** …and the next digit takes it back above the row count, which writes at once —
       * nothing is discarded, so nothing is priced. */
      it('writes the moment the number typed is no longer a removal', () => {
        const { onChange, onPoolsChange } = renderOwningCount()

        typeCount('1')
        typeCount('12')

        expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
        expect(onChange.mock.lastCall?.[0].drawOwnership.manualPoolCount).toBe(12)
        expect(onPoolsChange.mock.lastCall?.[0]).toHaveLength(12)
      })

      /** Destructive: two reservations go, with their windows and their tables. The
       * director is told **which** before it happens. */
      it('names the pools that would go', () => {
        renderOwningCount()

        typeCount('2')
        finishTyping()

        const dialog = drawStructureSectionPage.confirm.getDialog()
        expect(dialog).toHaveTextContent('Remove 2 pool reservations?')
        expect(dialog).toHaveTextContent('removes Pool C and Pool D')
      })

      it('names the event, so a director running several knows which one', () => {
        renderOwningCount()

        typeCount('3')
        finishTyping()

        expect(drawStructureSectionPage.confirm.getDialog()).toHaveTextContent(
          'Lowering the pool count for Two-stage Singles',
        )
      })

      /** Enter is the other way to say "done", for a director who never leaves the
       * keyboard. */
      it('prices it on Enter as well as on leaving the box', () => {
        renderOwningCount()

        typeCount('2')
        fireEvent.keyDown(
          drawStructureSectionPage.setting('Pool count').getInput(),
          { key: 'Enter' },
        )

        expect(drawStructureSectionPage.confirm.getDialog()).toHaveTextContent(
          'Remove 2 pool reservations?',
        )
      })

      it('drops the rows from the END on the confirm, and stores the count with them', () => {
        const { onChange, onPoolsChange } = renderOwningCount()

        typeCount('2')
        finishTyping()
        drawStructureSectionPage.confirm.confirm()

        expect(onChange.mock.lastCall?.[0].drawOwnership.manualPoolCount).toBe(2)
        expect(
          onPoolsChange.mock.lastCall?.[0].map((pool: PoolEntry) => pool.name),
        ).toEqual(['Pool A', 'Pool B'])
      })

      /**
       * **Go back changes nothing at all** — and the box says so.
       *
       * Asserting only that the callbacks did not fire would pass while the box went on
       * showing the `2` the director typed, which is a row claiming a pool count the event
       * does not have. The box reads the held number while the dialog is up and the stored
       * one the moment it is dropped.
       */
      it('restores the stored count on Go back, and touches no pool row', () => {
        const { onChange, onPoolsChange } = renderOwningCount()
        const row = drawStructureSectionPage.setting('Pool count')

        typeCount('2')
        finishTyping()
        expect(row.getInput()).toHaveValue('2')

        drawStructureSectionPage.confirm.cancel()

        expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
        expect(row.getInput()).toHaveValue('4')
        expect(onChange).not.toHaveBeenCalled()
        expect(onPoolsChange).not.toHaveBeenCalled()
      })

      /** Escape is the cancel, through the dialog's own channel. */
      it('reads Escape as Go back', () => {
        const { onPoolsChange } = renderOwningCount()

        typeCount('2')
        finishTyping()
        drawStructureSectionPage.confirm.pressEscape()

        expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
        expect(onPoolsChange).not.toHaveBeenCalled()
      })

      /** Leaving the box with nothing held asks nothing. A director who tabs through the
       * tab without typing must not meet a dialog. */
      it('asks nothing when the director leaves a box they never edited', () => {
        const { onChange, onPoolsChange } = renderOwningCount()

        finishTyping()

        expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
        expect(onChange).not.toHaveBeenCalled()
        expect(onPoolsChange).not.toHaveBeenCalled()
      })
    })

    /** A cleared box is **not** a count of none. The derivation reads a manual mode with
     * no number as automatic, so the count goes back to being the row count — and the rows
     * stay exactly where they are. Reconciling to `0` here would delete every pool of the
     * event because somebody selected the number to retype it. */
    it('clears to automatic without removing a single pool', () => {
      const { onChange, onPoolsChange } = renderOwningCount()

      typeCount('')

      expect(onChange.mock.lastCall?.[0].drawOwnership.manualPoolCount).toBeNull()
      expect(onPoolsChange).not.toHaveBeenCalled()
      expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
    })

    /** Typing the count the event's rows already have removes nothing, so it is priced by
     * nothing. Reachable, and worth pinning, from the one state where the stored count and
     * the row count legitimately differ: `Set myself` seeded 6 against 4 reservations, and
     * the director types the 4 they actually have. */
    it('asks no confirm when the typed count is the row count already', () => {
      const { onChange, onPoolsChange } = renderOwningCount({
        event: eventOwning({ poolCountMode: 'manual', manualPoolCount: 6 }),
      })

      typeCount('4')

      expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
      expect(onChange.mock.lastCall?.[0].drawOwnership.manualPoolCount).toBe(4)
      expect(
        onPoolsChange.mock.lastCall?.[0].map((pool: PoolEntry) => pool.name),
      ).toEqual(['Pool A', 'Pool B', 'Pool C', 'Pool D'])
    })

    /**
     * **`Set myself` creates no row**, and that is the ADR's point 3 rather than an
     * oversight: the count it seeds from is a *projection* against a field the app
     * invented, and a projection in excess of the rows is reported, never materialised.
     * Here 32 players in pools of 5 projects 7 pools over 4 reservations.
     *
     * The disagreement panel is what reports the gap, and its `Use {n} pools of {size}` is
     * what appends the rows — through the same `reconcilePoolsToCount` the box types
     * through.
     */
    it('creates no pool row when the director merely takes the setting', async () => {
      const onPoolsChange = vi.fn()
      drawStructureSectionPage.render({
        event: eventOwning({ poolSizeMode: 'manual', manualPoolSize: 5 }),
        onPoolsChange,
      })

      await userEvent.click(drawStructureSectionPage.setting('Pool count').getAction())

      expect(onPoolsChange).not.toHaveBeenCalled()
    })

    /** …and neither does handing it back. The automatic count IS the row count, so
     * `Use automatic` changes who owns the number and not how many pools exist. */
    it('creates and removes nothing when the director hands the setting back', async () => {
      const { onPoolsChange } = renderOwningCount()

      await userEvent.click(drawStructureSectionPage.setting('Pool count').getAction())

      expect(onPoolsChange).not.toHaveBeenCalled()
    })
  })

  /**
   * **The pool SET freeze reaches this tab too** (ADR 20260808's consequence, and the
   * server's `_enforce_pool_set_frozen`): once a draw is cut every fixture names the pool
   * it was dealt into, so a row this tab creates or removes is a 409. It is the *same*
   * freeze the Table pools tab is given — no second rule about the same fact.
   */
  describe('the pool set is frozen', () => {
    const FROZEN = {
      kind: 'frozen',
      reason:
        'Every fixture names the pool it was dealt into, so a pool can’t be added or ' +
        'removed while the draw stands.',
    } as const

    it('disables the pool count box and its action, and states why', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ poolCountMode: 'manual', manualPoolCount: 4 }),
        poolSetFreeze: FROZEN,
      })

      const row = drawStructureSectionPage.setting('Pool count')
      expect(row.getInput()).toBeDisabled()
      expect(row.getAction()).toBeDisabled()
      expect(row.queryFreezeReason()).toHaveTextContent(FROZEN.reason)
    })

    /** A disabled control is not focusable and carries no tooltip, so the only channel
     * left is the description it points at (#1223, the bug in the frozen draw-type
     * select). */
    it('points both dead controls at the reason', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ poolCountMode: 'manual', manualPoolCount: 4 }),
        poolSetFreeze: FROZEN,
      })

      const row = drawStructureSectionPage.setting('Pool count')
      expect(row.describedNodeOf(row.getInput())).toHaveTextContent(FROZEN.reason)
      expect(row.describedNodeOf(row.getAction())).toHaveTextContent(FROZEN.reason)
    })

    /** ⚠️ `Use automatic` alone would be a 200 — the server excludes ownership modes from
     * its freeze — so this half is the CLIENT's choice, exactly as the qualifiers row's is.
     * It is a one-way door: the automatic count is the row count, and `Set myself`, the
     * only way back, is frozen. */
    it('refuses the mode flip on that row too', async () => {
      const onChange = vi.fn()
      drawStructureSectionPage.render({
        event: eventOwning({ poolCountMode: 'manual', manualPoolCount: 4 }),
        poolSetFreeze: FROZEN,
        onChange,
      })

      await userEvent.click(drawStructureSectionPage.setting('Pool count').getAction())

      expect(onChange).not.toHaveBeenCalled()
    })

    /**
     * ⚠️ **The commonest cut event, and the one the tests above cannot reach.** An event
     * whose director never opened this tab stores no ownership record at all, so the pool
     * count is automatic: the row renders a *value* and a `Set myself`, and there is no box
     * to disable. That click seeds a manual count — the first step toward creating or
     * removing a row — so it is frozen too, and says why.
     */
    it('freezes Set myself on a cut event whose pool count is still automatic', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ drawOwnership: null }),
        poolSetFreeze: FROZEN,
      })

      const row = drawStructureSectionPage.setting('Pool count')
      expect(row.queryInput()).toBeNull()
      expect(row.getAction()).toHaveTextContent('Set myself')
      expect(row.getAction()).toBeDisabled()
      expect(row.describedNodeOf(row.getAction())).toHaveTextContent(FROZEN.reason)
    })

    it.each(['Pool size', 'Membership', 'Qualifiers per pool'])(
      'leaves %s alone — a frozen pool set says nothing about it',
      (name) => {
        drawStructureSectionPage.render({
          event: eventOwning({ poolSizeMode: 'manual', manualPoolSize: 8 }),
          poolSetFreeze: FROZEN,
        })

        const row = drawStructureSectionPage.setting(name)
        expect(row.getAction()).toBeEnabled()
        expect(row.queryFreezeReason()).toBeNull()
      },
    )
  })

  /** The row's automatic source sentence and the preview's `Pool reservations` fact are
   * two readings of ONE list, so they can never name two different numbers. */
  it('counts the same pool list in the source sentence and in the preview', () => {
    drawStructureSectionPage.render({
      event: buildDrawStructureEvent({
        pools: [
          buildPool({ id: 'p-a', name: 'Pool A', position: 0 }),
          buildPool({ id: 'p-b', name: 'Pool B', position: 1 }),
          buildPool({ id: 'p-c', name: 'Pool C', position: 2 }),
        ],
      }),
    })

    expect(
      drawStructureSectionPage.setting('Pool count').getSource(),
    ).toHaveTextContent("3 pool reservations · today's behaviour")
    expect(
      drawStructureSectionPage.preview.getFact('Pool reservations'),
    ).toHaveTextContent('3')
  })

  /**
   * **K is the one setting on this tab that can be left in a state the save refuses**, and
   * so the one with a red. It is required on every `rr-then-ko` event, and its box is the
   * only one a director can empty (the other three boxes drop a keystroke the schema would
   * reject rather than storing it).
   *
   * The row it moved from carried the same slot. Without it, a save refused for the count
   * would open this tab — `firstInvalidSection` sends it here now — with nothing red on it.
   */
  it('prints the resolver’s red on the qualifier row, and nowhere else', () => {
    drawStructureSectionPage.render({
      event: eventOwning({ qualifiersMode: 'manual' }, { qualifiersPerPool: null }),
      errors: { qualifiersPerPool: 'Say how many players advance from each pool.' },
    })

    const row = drawStructureSectionPage.setting('Qualifiers per pool')
    expect(row.queryError()).toHaveTextContent(
      'Say how many players advance from each pool.',
    )
    expect(row.getInput()).toHaveAttribute('aria-invalid', 'true')
    expect(
      drawStructureSectionPage.setting('Pool count').queryError(),
    ).toBeNull()
  })

  /**
   * A non-creator gets a **view** (ADR-0015): every value as text, and not one control —
   * no box, no action, and no imperative sending them to a tab where the cap is not
   * theirs to change either. Swept by `@/test/read-only`, which is the one sweep, never a
   * selector re-typed here.
   */
  describe('a reader', () => {
    it('sees no interactive control anywhere on the tab', () => {
      drawStructureSectionPage.render({
        // Two settings already taken, so a live tab would render two boxes and four
        // actions here. A guard against an empty tab is a guard against nothing.
        event: eventOwning({
          poolCountMode: 'manual',
          manualPoolCount: 6,
          membershipMode: 'manual',
        }),
        canEdit: false,
      })

      expect(drawStructureSectionPage.getFormElements()).toHaveLength(0)
      expect(drawStructureSectionPage.queryChangeInBasicsButton()).toBeNull()
    })

    it('still reads out every number and who owns it', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ poolCountMode: 'manual', manualPoolCount: 6 }),
        canEdit: false,
      })

      const row = drawStructureSectionPage.setting('Pool count')
      expect(row.getValue()).toHaveTextContent('6')
      expect(row.getOwnershipBadge()).toHaveTextContent('Yours')
    })

    /** …and the **qualifier count** by name, because it is the row that moved here (chore
     * 3e) and the claim came with it: a reader used to read K off the Basics tab, and a
     * move that dropped the read-only half would leave them with no way to see it at all.
     *
     * It also tightens the sweep above, which never sets `qualifiersMode` — so that guard
     * passes today whether or not this row honours `canEdit`. */
    it('reads out the qualifier count a director owns, as a value and not a box', () => {
      drawStructureSectionPage.render({
        event: eventOwning({ qualifiersMode: 'manual' }, { qualifiersPerPool: 3 }),
        canEdit: false,
      })

      const row = drawStructureSectionPage.setting('Qualifiers per pool')
      expect(row.getValue()).toHaveTextContent('3')
      expect(row.getOwnershipBadge()).toHaveTextContent('Yours')
      expect(row.queryInput()).toBeNull()
      expect(row.queryAction()).toBeNull()
    })
  })

  // Row copy, not the 2d notice panel: an all-automatic split is uneven whenever the
  // field does not divide, and the row has to say so rather than round.
  it('reads an uneven split as a range, and says "uneven" in the unit', () => {
    drawStructureSectionPage.render({
      event: buildDrawStructureEvent({
        pools: [
          buildPool({ id: 'p-a', name: 'Pool A', position: 0 }),
          buildPool({ id: 'p-b', name: 'Pool B', position: 1 }),
          buildPool({ id: 'p-c', name: 'Pool C', position: 2 }),
        ],
      }),
    })

    // 32 across 3 is 11, 11, 10.
    const row = drawStructureSectionPage.setting('Pool size')
    expect(row.getValue()).toHaveTextContent('10–11')
    expect(row.queryUnit()).toHaveTextContent('players · uneven')
  })

  it('says "pool", singular, when the field runs in one', () => {
    drawStructureSectionPage.render({
      event: buildDrawStructureEvent({ pools: [buildPool()] }),
    })

    const row = drawStructureSectionPage.setting('Pool count')
    expect(row.getValue()).toHaveTextContent('1')
    expect(row.queryUnit()).toHaveTextContent('pool')
  })

  describe('the field the preview derives against', () => {
    it('is the cap the director set, and says so', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.getPreviewFieldSize()).toHaveTextContent(
        '32',
      )
      expect(drawStructureSectionPage.getPreviewBasis()).toHaveTextContent(
        '32-player cap',
      )
    })

    /**
     * ⚠️ The deviation #1320 requires. The reference labels the basis `{n}-player cap`
     * in every state, which for an uncapped event names a cap nobody set — and would
     * send a director to the Basics tab looking for a number that is not there.
     */
    it('falls back to 16 for an uncapped event, and does NOT call the 16 a cap', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ maxPlayers: null }),
      })

      expect(drawStructureSectionPage.getPreviewFieldSize()).toHaveTextContent(
        '16',
      )
      expect(drawStructureSectionPage.getPreviewBasis()).toHaveTextContent(
        '16 players because this event has no cap',
      )
      expect(drawStructureSectionPage.getPreviewBasis()).not.toHaveTextContent(
        '16-player cap',
      )
      // …and the whole tab is derived against it: 16 over 4 pools is 4 apiece.
      expect(
        drawStructureSectionPage.setting('Pool size').getSource(),
      ).toHaveTextContent('16 players ÷ 4 pools')
    })

    it('sends the director to Basics to change it', async () => {
      const onGoToBasics = vi.fn()
      drawStructureSectionPage.render({ onGoToBasics })

      await userEvent.click(drawStructureSectionPage.getChangeInBasicsButton())

      expect(onGoToBasics).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * Wiring only: the preview's copy, states and arithmetic are pinned by
   * `draw-preview.test.tsx`. What the tab owns is that the preview sits in the right
   * column and is fed the same derivation the rows read.
   */
  describe('the live preview', () => {
    it('fills the right-hand column', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.getPreviewSlot()).toContainElement(
        drawStructureSectionPage.preview.getPreview(),
      )
    })

    it('is derived from the same numbers the rows read out', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.preview.getEquation()).toHaveTextContent(
        '32 players ÷ 4 pools = 8 per pool',
      )
      expect(
        drawStructureSectionPage.preview.getFact('Pool reservations'),
      ).toHaveTextContent('4')
    })

    // One call to `previewBasisLabel`, two readers — so the heading block and the
    // preview can never come to say different things about the same number.
    it('says the same thing about the preview field as the heading block does', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ maxPlayers: null }),
      })

      const basis = '16 players because this event has no cap'
      expect(drawStructureSectionPage.getPreviewBasis()).toHaveTextContent(basis)
      expect(
        drawStructureSectionPage.preview.getFact('Preview basis'),
      ).toHaveTextContent(basis)
    })

    // There is exactly one verdict on this tab. A second summary would give a director
    // two places to look and let one of them go stale.
    it('is the tab’s only summary of the draw', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.preview.queryAllPreviews()).toHaveLength(1)
      expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
        'Ready to save',
      )
    })
  })

  /**
   * Wiring and precedence. The panel's copy and its role are pinned by
   * `draw-issue-panel.test.tsx`; what the tab owns is which notice appears, and where.
   */
  describe('the one notice', () => {
    it('says nothing about a draw that divides — 32 across 4', () => {
      drawStructureSectionPage.render()

      expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
    })

    // The reference's "Uneven field" state: 22 across 4 is 6, 6, 5, 5.
    it('reads out an uneven split, under the settings that produced it', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({ maxPlayers: 22 }),
      })

      const panel = drawStructureSectionPage.issuePanel.getPanel()
      expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
        '2 pools of 6 · 2 pools of 5',
      )
      // The left column, beside the preview and not inside it.
      expect(drawStructureSectionPage.getPreviewSlot()).not.toContainElement(
        panel,
      )
    })

    /**
     * ⚠️ **The reference's "Numbers disagree" state** — 40 players over 6 pools of 5 seats
     * 30, and #1320's required case. A disagreement needs pool count AND pool size both
     * manual.
     *
     * The notice and the preview say the same thing about the same draw, in the two
     * registers the tab has: the panel asks the question under the settings that raise it,
     * and the badge states the verdict beside them.
     */
    it('asks for a decision — 6 pools of 5, 40 players', () => {
      drawStructureSectionPage.render({ event: numbersDisagree() })

      expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
        'Your numbers disagree',
      )
      expect(
        drawStructureSectionPage.issuePanel.getPanel(),
      ).toHaveAttribute('data-issue-kind', 'disagreement')
      expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
        '6 pools of 5 seat 30. Your field is 40.',
      )
      // Both of the director's numbers stand, unedited — the app states the arithmetic
      // rather than moving one of them (ADR 20260808).
      expect(drawStructureSectionPage.preview.getEquation()).toHaveTextContent(
        '40 players ÷ 6 pools = 5 per pool',
      )
      // …and the gap the reference's `max(reservations, derived)` would have hidden: the
      // draw needs six pools and the event has four rows.
      expect(
        drawStructureSectionPage.preview.getFact('Pool reservations'),
      ).toHaveTextContent('4')
    })

    /**
     * ⚠️ **The claim the whole variant exists for.** Nothing on this tab may add a pool or
     * enlarge one to make the arithmetic come out: reporting a standoff is not an occasion
     * to resolve it (ADR 20260808 — report, do not reshape).
     *
     * The rows and the boxes are necessary but not sufficient — a write that landed and was
     * then re-derived away would leave both looking right. The teeth are that rendering
     * this state writes **nothing at all**: no event, no pool list.
     */
    it('writes neither number, and mints no pool, merely by reporting it', () => {
      const onChange = vi.fn()
      const onPoolsChange = vi.fn()
      drawStructureSectionPage.render({
        event: numbersDisagree(),
        onChange,
        onPoolsChange,
      })

      expect(onChange).not.toHaveBeenCalled()
      expect(onPoolsChange).not.toHaveBeenCalled()
      // Both boxes still read what the director typed…
      expect(
        drawStructureSectionPage.setting('Pool count').getInput(),
      ).toHaveValue('6')
      expect(
        drawStructureSectionPage.setting('Pool size').getInput(),
      ).toHaveValue('5')
      // …and the six pools are six pools of five, not five and a bigger one.
      expect(drawStructureSectionPage.preview.getPoolCards()).toHaveLength(6)
    })

    /**
     * A reader gets a **view** (ADR-0015): the standoff is stated, because a preview
     * reading `Your call` with no cause beside it is a dead end — and nothing is offered,
     * because none of these settings is theirs to resolve.
     *
     * ⚠️ **Not a duplicate of the refusal's reader guard.** This is the only read-only
     * state on the tab where **both** dimension settings are the director's, so it is the
     * one guard that proves the two manual boxes are gated on `canEdit` and not merely on
     * the stored mode. The refusal's guard runs on an event that owns nothing, and has no
     * box to leak.
     */
    it('offers a reader no resolution, and still states the standoff', () => {
      drawStructureSectionPage.render({
        event: numbersDisagree(),
        canEdit: false,
      })

      expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
        '6 pools of 5 seat 30. Your field is 40.',
      )
      expect(drawStructureSectionPage.issuePanel.getFixes()).toHaveLength(0)
      expect(drawStructureSectionPage.getFormElements()).toHaveLength(0)
    })

    /**
     * ⚠️ The case the precedence exists for, and the reference's "Field too small" state:
     * 8 players over 6 pool reservations splits `2, 2, 1, 1, 1, 1`. That is an uneven
     * tally AND four pools nobody can play in, both reported at once — and
     * `Legal, but uneven` is not the thing to say about a pool of one.
     *
     * The Pool size row proves the tally really is there. Without it this test would
     * also pass on a draw that is not uneven at all, and prove nothing about the order.
     */
    it('drops the uneven notice when a pool cannot be played — 8 across 6', () => {
      drawStructureSectionPage.render({ event: eventTooSmallForItsPools() })

      const row = drawStructureSectionPage.setting('Pool size')
      expect(row.getValue()).toHaveTextContent('1–2')
      expect(row.queryUnit()).toHaveTextContent('players · uneven')

      // The refusal, not the tally: `Legal, but uneven` is not the thing to say about a
      // pool with one player in it.
      expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
        'Pool C would have one player',
      )
      expect(
        drawStructureSectionPage.issuePanel.getPanel(),
      ).toHaveAttribute('data-issue-kind', 'impossible')
      // …and the preview beside it says the same thing about the same draw.
      expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
        'This draw can’t work yet',
      )
    })
  })

  /**
   * **The named ways out of a refusal** (#1320's `Can’t save` panel). Each `Apply` writes
   * through a seam that already exists — the pool rows, the player limit on Basics, the
   * qualifier count — so a fix is a shortcut to a setting the director could have changed
   * themselves and never a second way to change it.
   *
   * The labels and their arithmetic are pinned by `draw-issue-fix.test.ts`, and the panel's
   * markup by `draw-issue-panel.test.tsx`. What the tab owns is what a click *does*, and
   * that the draw it leaves behind is one the editor would save.
   */
  describe('applying a fix', () => {
    /**
     * Re-render the tab on the event and pools a fix produced — the state the director is
     * actually left looking at, which is the only way to say "this fix works".
     *
     * These props are spies, so nothing feeds the write back into the component: the test
     * closes that loop itself, the way the editor's form does. `cleanup` first, because a
     * second `render` would otherwise leave two tabs on screen and every screen-scoped
     * query would throw on the ambiguity.
     *
     * A fix that wrote only one of the two (the event, or the pool list) falls back to
     * what was already there — which is exactly how a half-applied fix shows up as a
     * refusal that will not clear.
     */
    const rerenderOn = (
      onChange: ReturnType<typeof vi.fn>,
      onPoolsChange: ReturnType<typeof vi.fn>,
      previous: { event: TournamentEvent; pools: PoolEntry[] },
    ) => {
      const event: TournamentEvent = onChange.mock.lastCall?.[0] ?? previous.event
      const pools: PoolEntry[] = onPoolsChange.mock.lastCall?.[0] ?? previous.pools
      cleanup()
      drawStructureSectionPage.render({ event, pools })
      return { event, pools }
    }

    describe('a pool nobody can play in — 8 players over 6 pools', () => {
      const renderTooSmall = () => {
        const onChange = vi.fn()
        const onPoolsChange = vi.fn()
        const event = eventTooSmallForItsPools()
        drawStructureSectionPage.render({ event, onChange, onPoolsChange })
        return { onChange, onPoolsChange, event }
      }

      it('offers both of the reference’s ways out', () => {
        renderTooSmall()

        expect(drawStructureSectionPage.issuePanel.getFixLabels()).toEqual([
          'Use 4 pools',
          'Raise the player limit to 12',
        ])
      })

      /**
       * ⚠️ **Fewer pools means fewer pool ROWS** (ADR 20260808), so this fix discards two
       * reservations — and it is priced by the same confirm the Pool count box is, naming
       * them before any of them goes (ADR 20260806). A fix that quietly dropped a
       * reservation would be the one unpriced path to an act every other path prices.
       */
      it('prices the reservations `Use 4 pools` would drop', async () => {
        renderTooSmall()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Use 4 pools'),
        )

        expect(
          drawStructureSectionPage.confirm.getDialog(),
        ).toHaveTextContent('Pool E')
        expect(
          drawStructureSectionPage.confirm.getDialog(),
        ).toHaveTextContent('Pool F')
      })

      it('writes neither the count nor the rows until that is confirmed', async () => {
        const { onChange, onPoolsChange } = renderTooSmall()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Use 4 pools'),
        )

        expect(onChange).not.toHaveBeenCalled()
        expect(onPoolsChange).not.toHaveBeenCalled()
      })

      /** The number and the rows, in ONE act — the ADR's demand, and the claim that would
       * red if the fix wrote its count straight to the ownership record and left the six
       * reservations standing. */
      it('drops the rows from the end on the confirm, and stores the count with them', async () => {
        const { onChange, onPoolsChange } = renderTooSmall()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Use 4 pools'),
        )
        await userEvent.click(drawStructureSectionPage.confirm.getConfirmButton())

        expect(onChange.mock.lastCall?.[0].drawOwnership.manualPoolCount).toBe(4)
        expect(
          onPoolsChange.mock.lastCall?.[0].map((pool: PoolEntry) => pool.name),
        ).toEqual(['Pool A', 'Pool B', 'Pool C', 'Pool D'])
      })

      it('leaves a draw the editor would save', async () => {
        const { onChange, onPoolsChange, event } = renderTooSmall()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Use 4 pools'),
        )
        await userEvent.click(drawStructureSectionPage.confirm.getConfirmButton())
        rerenderOn(onChange, onPoolsChange, {
          event,
          pools: keepPools(event.pools),
        })

        // 8 across 4 is 2, 2, 2, 2 — no pool of one, no notice at all.
        expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
        expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
          'Ready to save',
        )
      })

      /** The other direction, and the one setting on this tab that is not on this tab: the
       * player limit lives on Basics, and the fix writes it through the same `onChange`
       * the Basics tab writes through. **No pool row moves** — that is what
       * `Keeps your pool count.` promises. */
      it('raises the player limit without touching a reservation', async () => {
        const { onChange, onPoolsChange } = renderTooSmall()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton(
            'Raise the player limit to 12',
          ),
        )

        expect(onChange.mock.lastCall?.[0].maxPlayers).toBe(12)
        expect(onPoolsChange).not.toHaveBeenCalled()
        expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
      })

      it('leaves a draw the editor would save, that way too', async () => {
        const { onChange, onPoolsChange, event } = renderTooSmall()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton(
            'Raise the player limit to 12',
          ),
        )
        rerenderOn(onChange, onPoolsChange, {
          event,
          pools: keepPools(event.pools),
        })

        // 12 across the same 6 pools is 2 apiece.
        expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
        expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
          'Ready to save',
        )
      })
    })

    /**
     * #1320's own case: one pool taking one qualifier sends one player to the knockout,
     * and the app used to refuse the *cut* with a message naming the wrong cause.
     */
    describe('a one-player knockout — 1 pool, top 1', () => {
      const onePoolTakingOne = () =>
        eventOwning(
          { qualifiersMode: 'manual' },
          {
            maxPlayers: 16,
            qualifiersPerPool: 1,
            pools: [buildPool({ id: 'p-a', name: 'Pool A', position: 0 })],
          },
        )

      it('names the cause and offers the one way out', () => {
        drawStructureSectionPage.render({ event: onePoolTakingOne() })

        expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
          'The knockout would have one player',
        )
        expect(drawStructureSectionPage.issuePanel.getFixLabels()).toEqual([
          'Take top 2',
        ])
      })

      /** The count **and** the ownership: the director asked for two through, so the row
       * must read `Yours`. Left automatic, the derivation would go on aiming at a bracket
       * of eight and hand the number straight back. */
      it('takes the qualifier setting as well as setting the number', async () => {
        const onChange = vi.fn()
        drawStructureSectionPage.render({ event: onePoolTakingOne(), onChange })

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Take top 2'),
        )

        expect(onChange.mock.lastCall?.[0].qualifiersPerPool).toBe(2)
        expect(onChange.mock.lastCall?.[0].drawOwnership.qualifiersMode).toBe(
          'manual',
        )
      })

      it('leaves a draw the editor would save', async () => {
        const onChange = vi.fn()
        const onPoolsChange = vi.fn()
        const event = onePoolTakingOne()
        drawStructureSectionPage.render({ event, onChange, onPoolsChange })

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Take top 2'),
        )
        rerenderOn(onChange, onPoolsChange, {
          event,
          pools: keepPools(event.pools),
        })

        expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
        expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
          'Ready to save',
        )
      })
    })

    /**
     * Three through from a pool that holds two. 10 players over 4 pools splits
     * `3, 3, 2, 2`, so the fix names **two** — the smallest pool, not the average.
     */
    describe('more qualifiers than the smallest pool holds — top 3 from a pool of 2', () => {
      const topThreeFromTwo = () =>
        eventOwning(
          { poolCountMode: 'manual', manualPoolCount: 4, qualifiersMode: 'manual' },
          { maxPlayers: 10, qualifiersPerPool: 3 },
        )

      it('names the cause in the reference’s words, apostrophe and all', () => {
        drawStructureSectionPage.render({ event: topThreeFromTwo() })

        expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
          'You can’t take 3 qualifiers from a pool of 2',
        )
        expect(drawStructureSectionPage.issuePanel.getFixLabels()).toEqual([
          'Take top 2',
        ])
      })

      it('cuts the qualifier count down to what the smallest pool holds', async () => {
        const onChange = vi.fn()
        drawStructureSectionPage.render({ event: topThreeFromTwo(), onChange })

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Take top 2'),
        )

        expect(onChange.mock.lastCall?.[0].qualifiersPerPool).toBe(2)
      })

      /** Saveable is **not** the same as silent: 10 across 4 is still an uneven split, and
       * the tab goes on saying so. What it stops saying is that the draw cannot be
       * played. */
      it('leaves a draw the editor would save, still uneven', async () => {
        const onChange = vi.fn()
        const onPoolsChange = vi.fn()
        const event = topThreeFromTwo()
        drawStructureSectionPage.render({ event, onChange, onPoolsChange })

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Take top 2'),
        )
        rerenderOn(onChange, onPoolsChange, {
          event,
          pools: keepPools(event.pools),
        })

        expect(
          drawStructureSectionPage.issuePanel.getPanel(),
        ).toHaveAttribute('data-issue-kind', 'uneven')
        expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
          'Ready to save',
        )
      })
    })

    /**
     * **The reference's "Numbers disagree" state, resolved three ways** — 40 players over
     * six pools of five, which seat thirty.
     *
     * Every one of the three is a named act the director chooses, and the two they do not
     * choose leave their numbers exactly as they were. The labels and their arithmetic are
     * pinned by `draw-issue-fix.test.ts`; what these pin is what a click *does*, and that
     * the draw it leaves behind no longer disagrees.
     */
    describe('numbers that disagree — 6 pools of 5, 40 players', () => {
      const renderDisagreement = (
        overrides: Partial<Parameters<typeof drawStructureSectionPage.render>[0]> = {},
      ) => {
        const onChange = vi.fn()
        const onPoolsChange = vi.fn()
        const event = numbersDisagree()
        drawStructureSectionPage.render({
          event,
          onChange,
          onPoolsChange,
          ...overrides,
        })
        return { onChange, onPoolsChange, event }
      }

      it('offers all three of the reference’s resolutions, in order', () => {
        renderDisagreement()

        expect(drawStructureSectionPage.issuePanel.getFixLabels()).toEqual([
          'Cap the field at 30',
          'Use 8 pools of 5',
          'Allow uneven pools',
        ])
      })

      /** The field moves to the structure. `Your structure stays exact.` is literal: the
       * cap is the only thing written, and both of the director's numbers survive it. */
      it('caps the field without touching either of the director’s numbers', async () => {
        const { onChange, onPoolsChange } = renderDisagreement()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Cap the field at 30'),
        )

        expect(onChange.mock.lastCall?.[0].maxPlayers).toBe(30)
        expect(onChange.mock.lastCall?.[0].drawOwnership).toEqual(
          expect.objectContaining({
            poolCountMode: 'manual',
            manualPoolCount: 6,
            poolSizeMode: 'manual',
            manualPoolSize: 5,
          }),
        )
        expect(onPoolsChange).not.toHaveBeenCalled()
        expect(drawStructureSectionPage.confirm.queryDialog()).toBeNull()
      })

      it('leaves a draw whose numbers agree', async () => {
        const { onChange, onPoolsChange, event } = renderDisagreement()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Cap the field at 30'),
        )
        rerenderOn(onChange, onPoolsChange, {
          event,
          pools: keepPools(event.pools),
        })

        // 6 pools of 5 seat exactly the 30 the field now holds.
        expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
        expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
          'Ready to save',
        )
      })

      /**
       * ⚠️ **`Use 8 pools of 5` is eight pool RESERVATIONS**, not a number written into the
       * ownership record beside four rows (ADR 20260808). This is the resolution that
       * materialises the projection `Set myself` deliberately does not, and it does it
       * through `reconcilePoolsToCount` — the seam the Pool count box types through.
       */
      it('appends the pool rows the count needs, in the same act as the count', async () => {
        const { onChange, onPoolsChange } = renderDisagreement()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Use 8 pools of 5'),
        )

        expect(onChange.mock.lastCall?.[0].drawOwnership.manualPoolCount).toBe(8)
        expect(
          onPoolsChange.mock.lastCall?.[0].map((pool: PoolEntry) => pool.name),
        ).toEqual([
          'Pool A',
          'Pool B',
          'Pool C',
          'Pool D',
          'Pool E',
          'Pool F',
          'Pool G',
          'Pool H',
        ])
      })

      it('leaves a draw whose numbers agree, and a reservation for every pool', async () => {
        const { onChange, onPoolsChange, event } = renderDisagreement()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Use 8 pools of 5'),
        )
        rerenderOn(onChange, onPoolsChange, {
          event,
          pools: keepPools(event.pools),
        })

        expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
        expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
          'Ready to save',
        )
        // The gap this resolution exists to close: eight pools, eight reservations.
        expect(
          drawStructureSectionPage.preview.getFact('Pool reservations'),
        ).toHaveTextContent('8')
      })

      /**
       * ⚠️ **The pool count is the director's and survives.** `Allow uneven pools` is an
       * answer about the pool *size*: it hands that one setting back and touches nothing
       * else — not the count, not the count's mode, and not a pool row. Clearing the count
       * with it would discard a number they typed to answer a question about a different
       * one.
       *
       * The size they typed is remembered, unset rather than erased, exactly as the Pool
       * size row's own `Use automatic` leaves it (`data/draw-ownership`).
       */
      it('hands the pool SIZE back, and keeps the count the director typed', async () => {
        const { onChange, onPoolsChange } = renderDisagreement()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Allow uneven pools'),
        )

        expect(onChange.mock.lastCall?.[0].drawOwnership).toEqual(
          expect.objectContaining({
            poolSizeMode: 'automatic',
            poolCountMode: 'manual',
            manualPoolCount: 6,
            manualPoolSize: 5,
          }),
        )
        expect(onChange.mock.lastCall?.[0].maxPlayers).toBe(40)
        expect(onPoolsChange).not.toHaveBeenCalled()
      })

      /** …and the split it promised is the split it produces: 40 across the director's six
       * pools is `7, 7, 7, 7, 6, 6`. Uneven is the point — the resolution is called
       * `Allow uneven pools` — so the tab goes on saying so, in the notice for a legal
       * split. What it stops saying is that the numbers disagree. */
      it('leaves the 4 × 7 and 2 × 6 it promised, legal and merely uneven', async () => {
        const { onChange, onPoolsChange, event } = renderDisagreement()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Allow uneven pools'),
        )
        rerenderOn(onChange, onPoolsChange, {
          event,
          pools: keepPools(event.pools),
        })

        expect(
          drawStructureSectionPage.issuePanel.getPanel(),
        ).toHaveAttribute('data-issue-kind', 'uneven')
        expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
          '4 pools of 7 · 2 pools of 6',
        )
        expect(
          drawStructureSectionPage.setting('Pool size').getValue(),
        ).toHaveTextContent('6–7')
        expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
          'Ready to save',
        )
      })
    })

    /**
     * ⚠️ **A resolution that lowers the pool count is priced like every other lowered pool
     * count.** 12 players over six pools of three seat eighteen, and `Use 4 pools of 3`
     * discards two reservations — so it goes through the *same* gate (`requestPoolCount`)
     * and the same confirm the box does, naming them before any of them goes (ADR
     * 20260806). Without this vector the required case only ever appends, and "the fix
     * reuses the gate" would be an inheritance rather than a claim.
     */
    describe('a resolution that drops reservations — 12 players, 6 pools of 3', () => {
      const renderCostly = () => {
        const onChange = vi.fn()
        const onPoolsChange = vi.fn()
        const event = eventOwning(
          {
            poolCountMode: 'manual',
            manualPoolCount: 6,
            poolSizeMode: 'manual',
            manualPoolSize: 3,
          },
          {
            maxPlayers: 12,
            pools: Array.from({ length: 6 }, (_, i) =>
              buildPool({
                id: `p-${poolLetter(i).toLowerCase()}`,
                name: `Pool ${poolLetter(i)}`,
                position: i,
              }),
            ),
          },
        )
        drawStructureSectionPage.render({ event, onChange, onPoolsChange })
        return { onChange, onPoolsChange, event }
      }

      it('names the reservations it would drop, and writes nothing yet', async () => {
        const { onChange, onPoolsChange } = renderCostly()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Use 4 pools of 3'),
        )

        expect(drawStructureSectionPage.confirm.getDialog()).toHaveTextContent(
          'Pool E',
        )
        expect(drawStructureSectionPage.confirm.getDialog()).toHaveTextContent(
          'Pool F',
        )
        expect(onChange).not.toHaveBeenCalled()
        expect(onPoolsChange).not.toHaveBeenCalled()
      })

      it('drops them on the confirm, and leaves a draw whose numbers agree', async () => {
        const { onChange, onPoolsChange, event } = renderCostly()

        await userEvent.click(
          drawStructureSectionPage.issuePanel.getApplyButton('Use 4 pools of 3'),
        )
        await userEvent.click(drawStructureSectionPage.confirm.getConfirmButton())

        expect(onChange.mock.lastCall?.[0].drawOwnership.manualPoolCount).toBe(4)
        expect(
          onPoolsChange.mock.lastCall?.[0].map((pool: PoolEntry) => pool.name),
        ).toEqual(['Pool A', 'Pool B', 'Pool C', 'Pool D'])

        rerenderOn(onChange, onPoolsChange, {
          event,
          pools: keepPools(event.pools),
        })
        expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
        expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
          'Ready to save',
        )
      })
    })

    /** A reader gets a **view** (ADR-0015). The refusal still says why the draw cannot be
     * played — hiding that would leave them reading a preview badge with no cause — and it
     * offers nothing to press, because none of these settings is theirs. */
    it('offers a reader no way to apply one', () => {
      drawStructureSectionPage.render({
        event: eventTooSmallForItsPools(),
        canEdit: false,
      })

      expect(drawStructureSectionPage.issuePanel.getTitle()).toHaveTextContent(
        'Pool C would have one player',
      )
      expect(drawStructureSectionPage.issuePanel.getFixes()).toHaveLength(0)
      expect(drawStructureSectionPage.getFormElements()).toHaveLength(0)
    })
  })
})
