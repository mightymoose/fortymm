import userEvent from '@testing-library/user-event'

import { everySettingAutomatic } from '../../data/draw-ownership'
import { buildPool } from '../../data/seed.factory'
import type { DrawOwnership, TournamentEvent } from '../../data/types'
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

    it.each(['Pool count', 'Pool size', 'Membership'])(
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
     * ⚠️ **The reference's "Numbers disagree" state, reachable for the first time in this
     * chore** — a disagreement needs pool count AND pool size both manual, which nothing
     * could set until now. 40 players over 6 pools of 5 seats 30.
     *
     * The panel for it is chore 5a, so the tab shows **nothing** rather than a
     * half-written notice — and the director is not left guessing, because the preview
     * beside it says so in the reference's words. This test is the guard on that split:
     * it reds the day a panel appears here without its `Apply` fixes, and it reds the day
     * the preview stops saying it.
     */
    it('leaves the disagreement to the preview — 6 pools of 5, 40 players', () => {
      drawStructureSectionPage.render({
        event: eventOwning(
          {
            poolCountMode: 'manual',
            manualPoolCount: 6,
            poolSizeMode: 'manual',
            manualPoolSize: 5,
          },
          { maxPlayers: 40 },
        ),
      })

      expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
        'Your numbers disagree',
      )
      expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
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
     * ⚠️ The case the precedence exists for, and the reference's "Field too small" state:
     * 8 players over 6 pool reservations splits `2, 2, 1, 1, 1, 1`. That is an uneven
     * tally AND four pools nobody can play in, both reported at once — and
     * `Legal, but uneven` is not the thing to say about a pool of one.
     *
     * The Pool size row proves the tally really is there. Without it this test would
     * also pass on a draw that is not uneven at all, and prove nothing about the order.
     */
    it('drops the uneven notice when a pool cannot be played — 8 across 6', () => {
      drawStructureSectionPage.render({
        event: buildDrawStructureEvent({
          maxPlayers: 8,
          pools: Array.from({ length: 6 }, (_, i) =>
            buildPool({ id: `p-${i}`, name: `Pool ${i}`, position: i }),
          ),
        }),
      })

      const row = drawStructureSectionPage.setting('Pool size')
      expect(row.getValue()).toHaveTextContent('1–2')
      expect(row.queryUnit()).toHaveTextContent('players · uneven')

      expect(drawStructureSectionPage.issuePanel.queryPanel()).toBeNull()
      // …and the director is not left guessing: the preview says so.
      expect(drawStructureSectionPage.preview.getVerdict()).toHaveTextContent(
        'This draw can’t work yet',
      )
    })
  })
})
