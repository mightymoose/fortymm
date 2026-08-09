import { Overline } from '@/components/overline'
import { Button } from '@/components/ui/button'

import type { EditFreeze } from '../../data/draw'
import {
  MANUAL_POOL_DIMENSION_MAX,
  everySettingAutomatic,
  type DrawOwnership,
} from '../../data/draw-ownership'
import { deriveDrawStructure } from '../../data/draw-structure'
import { QUALIFIERS_PER_POOL_MAX } from '../../data/event-validation'
import type { TournamentEvent } from '../../data/types'
import { drawIssueFor } from './draw-structure-section/draw-issue'
import { DrawIssuePanel } from './draw-structure-section/draw-issue-panel'
import { DrawPreview } from './draw-structure-section/draw-preview'
import {
  previewBasisLabel,
  previewFieldSize,
} from './draw-structure-section/preview-field'
import { SettingRow } from './draw-structure-section/setting-row'

/** Inline validation messages for the settings this tab owns, mapped from the editor's
 * React-Hook-Form state. Only the qualifier count can carry one: the other three settings
 * are typed through boxes that refuse a keystroke the schema would reject
 * (`acceptedManualEntry`), while K is a value the event must have and a box the director
 * can empty. Never shown to a reader — a reader has no box to be wrong in. */
export interface DrawStructureFieldErrors {
  qualifiersPerPool?: string
}

export interface DrawStructureSectionProps {
  /**
   * The event as the editor's **live draft** has it, so the tab recomputes as the
   * director edits the player limit or adds a pool on the tabs next door.
   *
   * ⚠️ `pools` is read as a *count* deliberately. The editor's draft carries the form's
   * `pools`, which are `PoolEntry` diffs rather than the read model's `Pool` rows (ADR
   * 20260801); the length is the same either way, and nothing here may touch a pool's
   * insides.
   */
  event: TournamentEvent
  /** When false (a non-creator), the tab is a **view**: every value is text, and there
   * is no action, no box and no way to Basics. Not a disabled form (ADR-0015). */
  canEdit: boolean
  /**
   * Write the edited event back to the editor's form — the same `onChange` the Basics
   * and Match settings tabs take, so a setting taken here is form state and not a
   * second draft this tab keeps to itself.
   *
   * The two fields it ever changes are `drawOwnership` and — when the director takes the
   * qualifier count — `qualifiersPerPool`, whose value is the qualifiers row's number
   * (the wire has no `manual_qualifiers`: the stored K *is* the manual slot).
   */
  onChange: (event: TournamentEvent) => void
  /**
   * Take the director to the Basics tab, where the player limit that sizes this preview
   * lives.
   *
   * A button, not a `<Link>`: Basics is a sibling tab inside this same sheet, so "go
   * there" is editor state and not navigation. A link would leave the page and lose the
   * unsaved draft.
   */
  onGoToBasics: () => void
  /** The resolver's red for the qualifier count, surfaced on its row. The tab does not
   * *decide* it: the editor resolves the whole form on submit and hands each tab its share,
   * so "may I save?" and "what does this row say in red?" are one answer computed once —
   * exactly as the Basics tab already works. */
  errors?: DrawStructureFieldErrors
  /** Whether the **qualifier count** may still be changed (`qualifiersPerPoolFreeze`,
   * `data/draw`). Frozen once the event's draw is cut: the knockout bracket was cut
   * upfront for `P × K`, so a moved K leaves qualifiers with no slot to be seated into — a
   * 409 on the server. Frozen means a disabled box and a disabled action, both pointing at
   * the reason (ADR 20260806); it does not mean a hidden row. The other three settings are
   * untouched by it — their modes size nothing the cut already put on the table, and the
   * server excludes them from the freeze on purpose.
   *
   * **Required, not optional.** A freeze a call site can forget is a freeze that silently
   * does not happen, and this one guards a 409. */
  qualifiersFreeze: EditFreeze
}

/**
 * The event editor's **Draw structure** tab (#1320) — the four structural settings of a
 * round-robin-then-knockout draw, each one the director's or the system's.
 *
 * ## Why the tab exists
 *
 * A director controlled one and a half of these four settings, and nothing on any tab
 * stated the other two (ADR 20260808). #1320 records a real director who set one pool and
 * one qualifier per pool, sent one player to the bracket, and was refused with a message
 * that named the wrong cause. This tab states every number, says where it came from, and
 * lets a director take any of them for themselves — or give it back.
 *
 * ## Taking a setting changes the owner, not the number
 *
 * `Set myself` seeds the box from what the row was already showing: the derived pool
 * count, the **largest** derived pool, the derived qualifier count. So the first click
 * moves nothing, and a director who wants to nudge a number by one does not first have to
 * work out what it currently is (ADR 20260808).
 *
 * `Use automatic` is the exact opposite of destructive: it sets the mode and **keeps the
 * number**, so a director who looks at what the system would say and comes back gets
 * their own number returned rather than an empty box.
 *
 * ## The badge follows the EFFECTIVE owner, the box follows the stored mode
 *
 * A director can own a setting and have cleared its box. The derivation reads that as
 * automatic — a manual mode with no number derives — and reports the ownership it
 * actually used, so the `Yours` badge and the source sentence can never disagree with
 * each other. The box and the action read the stored mode instead, so the row the
 * director took stays theirs and can still be handed back.
 *
 * ## The arithmetic is not here
 *
 * Every number and every source sentence comes from `deriveDrawStructure`
 * (`data/draw-structure`), whose vectors are asserted against a Python twin. A component
 * that recomputed even one of them would be a second implementation with no vector
 * holding it to the first.
 */
export const DrawStructureSection = ({
  event,
  canEdit,
  onChange,
  onGoToBasics,
  errors = {},
  qualifiersFreeze,
}: DrawStructureSectionProps) => {
  const fieldSize = previewFieldSize(event.maxPlayers)
  // ONE call, two readers — the heading block and the preview's `Preview basis` fact.
  // Called twice they could eventually be called with different arguments, and two
  // sentences about the same number is exactly the confusion #1320 removes.
  const previewBasis = previewBasisLabel(event.maxPlayers)
  // An `rr-then-ko` event that has never seen this tab stores no record, and the
  // all-automatic one is what that means (ADR 20260808 — "an event that sets nothing
  // behaves exactly as it does today"). A FRESH record, never a shared constant: it is
  // what every write below is built from, and a shared object would be one object every
  // event's toggle rewrote.
  const ownership = event.drawOwnership ?? everySettingAutomatic()

  const structure = deriveDrawStructure({
    previewFieldSize: fieldSize,
    // One pool reservation is one pool — today's behaviour, and the automatic source of
    // the pool count (ADR 20260808).
    poolReservationCount: event.pools.length,
    poolCountMode: ownership.poolCountMode,
    manualPoolCount: ownership.manualPoolCount,
    poolSizeMode: ownership.poolSizeMode,
    manualPoolSize: ownership.manualPoolSize,
    qualifiersMode: ownership.qualifiersMode,
    // **The event's own K is the manual slot.** There is no `manual_qualifiers` on the
    // wire: every `rr-then-ko` event already carries a qualifier count, and the mode is
    // what says whether anybody should read it. Passed unconditionally, exactly as the
    // API's comment describes, so the derivation's own `qualifiersMode` check decides.
    manualQualifiers: event.qualifiersPerPool,
  })

  /** Write a changed ownership record — always a **replacement**, never a mutation. The
   * `as const` on the wire-side twin gives readonly modifiers TypeScript does not check
   * on assignment, so a record edited in place would be one record every event shared. */
  const own = (next: Partial<DrawOwnership>, qualifiersPerPool = event.qualifiersPerPool) =>
    onChange({
      ...event,
      qualifiersPerPool,
      drawOwnership: { ...ownership, ...next },
    })

  // Read off the derived sizes rather than divided out again — the pools are routinely
  // unequal (22 across 4 is `6, 6, 5, 5`) and the uneven case is a first-class state.
  const smallestPool = Math.min(...structure.poolSizes)
  const largestPool = Math.max(...structure.poolSizes)
  const uneven = smallestPool !== largestPool

  const membershipManual = ownership.membershipMode === 'manual'

  // The ONE notice the tab shows, chosen in the reference's order — impossible, then
  // disagreement, then uneven. The derivation reports all three independently and more
  // than one can hold at once (8 players across 6 reservations is an uneven split whose
  // last four pools have one player each), so the choice is `drawIssueFor`'s and this tab
  // never re-derives it.
  const issue = drawIssueFor(structure)

  return (
    <div className="flex flex-col gap-6" data-testid="draw-structure-section">
      {/* **Stacked below `sm`, side by side above it** — the same breakpoint the sheet
          itself switches on (`w-full sm:w-[820px]`). A grid item's `min-width` is
          `auto`, so `minmax(0, …)` on both tracks is what keeps a long source sentence
          from widening the column past the sheet and hiding behind a horizontal
          scrollbar nothing advertises (the bug this editor has shipped twice). */}
      {/* 320px, not 280: at 280 the knockout card's `{n}-player bracket` wraps onto a
          second line beside its byes/matches column, which the reference keeps on one.
          Verified in a browser at the 1280px desktop width — jsdom does no layout, so
          no unit test can hold this number. */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="flex min-w-0 flex-col">
          <Overline className="text-[color:var(--ball-500)]">
            Draw structure
          </Overline>
          <h3
            data-testid="draw-structure-heading"
            className="mt-1.5 text-[22px] leading-tight font-semibold text-[color:var(--fg-1)]"
          >
            Set what matters. We’ll work out the rest.
          </h3>
          <p className="mt-1.5 text-[13px] text-[color:var(--fg-3)]">
            Pools play all-play-all. The top finishers move into a knockout
            bracket.
          </p>

          {/* The field every number below is derived from, stated before the numbers
              are. It is the one input to this tab that is not set on this tab, which is
              why it carries the way back to the tab that does set it. */}
          <div className="mt-4 w-fit rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-raised)] px-4 py-3">
            <div className="text-[11px] font-semibold tracking-[0.14em] text-[color:var(--fg-3)] uppercase">
              Preview field
            </div>
            <p className="mt-1 flex items-baseline gap-2">
              <span
                data-testid="draw-structure-field-size"
                className="font-mono text-[20px] leading-none font-semibold text-[color:var(--fg-1)]"
              >
                {fieldSize}
              </span>
              <span className="text-[13px] text-[color:var(--fg-2)]">
                players
              </span>
            </p>
            {/* Honest about where the number came from, which for an uncapped event
                means NOT calling it a cap (`previewBasisLabel`). */}
            <p
              data-testid="draw-structure-preview-basis"
              className="mt-1 text-[11px] text-[color:var(--fg-3)]"
            >
              {previewBasis}
            </p>
            {/* HIDDEN from a reader, not disabled (ADR-0015): "Change in Basics" is an
                imperative addressed to somebody who can change it, and the cap is not
                theirs to change. */}
            {canEdit && (
              <Button
                variant="link"
                size="sm"
                className="mt-1 h-auto p-0 text-[12px]"
                onClick={onGoToBasics}
              >
                Change in Basics
              </Button>
            )}
          </div>

          {/* ONE list with dividers, not one card per row. The divider is the list's, so
              a row contributes no border of its own and the four settings read as one
              draw rather than as four unrelated panels. */}
          <div className="mt-5 divide-y divide-[color:var(--border-subtle)] border-t border-[color:var(--border-subtle)]">
            <SettingRow
              name="Pool count"
              hint="How many pools the field splits into. Each pool also books its tables and time window."
              value={String(structure.poolCount)}
              kind="number"
              unit={structure.poolCount === 1 ? 'pool' : 'pools'}
              ownership={structure.sources.poolCount.ownership}
              source={structure.sources.poolCount.sentence}
              entry={
                canEdit && ownership.poolCountMode === 'manual'
                  ? {
                      value: ownership.manualPoolCount,
                      max: MANUAL_POOL_DIMENSION_MAX,
                      onChange: (value) => own({ manualPoolCount: value }),
                    }
                  : undefined
              }
              action={
                canEdit
                  ? ownership.poolCountMode === 'manual'
                    ? {
                        label: 'Use automatic',
                        // The mode only: the number stays, remembered for the next time
                        // they take the setting back.
                        onClick: () => own({ poolCountMode: 'automatic' }),
                      }
                    : {
                        label: 'Set myself',
                        // Seeded from the count the row was already showing.
                        onClick: () =>
                          own({
                            poolCountMode: 'manual',
                            manualPoolCount: structure.poolCount,
                          }),
                      }
                  : undefined
              }
            />
            {/* The uneven split is this row's own copy, not the 2d notice: `{min}–{max}`
                with the unit saying so out loud. An en dash, and a middle dot before
                `uneven` — both the reference's glyphs. */}
            <SettingRow
              name="Pool size"
              hint="The target number of players in each pool."
              value={uneven ? `${smallestPool}–${largestPool}` : String(smallestPool)}
              kind="number"
              unit={uneven ? 'players · uneven' : 'players per pool'}
              ownership={structure.sources.poolSize.ownership}
              source={structure.sources.poolSize.sentence}
              entry={
                canEdit && ownership.poolSizeMode === 'manual'
                  ? {
                      value: ownership.manualPoolSize,
                      max: MANUAL_POOL_DIMENSION_MAX,
                      onChange: (value) => own({ manualPoolSize: value }),
                    }
                  : undefined
              }
              action={
                canEdit
                  ? ownership.poolSizeMode === 'manual'
                    ? {
                        label: 'Use automatic',
                        onClick: () => own({ poolSizeMode: 'automatic' }),
                      }
                    : {
                        label: 'Set myself',
                        // **The LARGEST derived pool**, which is the target the split was
                        // aiming at: 22 across 4 is `6, 6, 5, 5`, and a director taking
                        // that setting is taking pools of six with a short one, not pools
                        // of five with a long one. Seeding the smallest would shrink the
                        // draw on the first click, which is the silent reshaping #1320
                        // exists to remove.
                        onClick: () =>
                          own({
                            poolSizeMode: 'manual',
                            manualPoolSize: largestPool,
                          }),
                      }
                  : undefined
              }
            />
            {/* Membership has no number, so `deriveDrawStructure` says nothing about it
                (its `DrawStructureSources` omits it by design). The row reads its mode
                straight off the event — and the automatic answer is not a shrug, it is
                `_snake()` in `api/app/draws.py`, which already deals every cut. */}
            <SettingRow
              name="Membership"
              hint="Who lands in each pool. Entrants do not exist until you cut the draw."
              value={membershipManual ? 'Assign at cut time' : 'Snake automatically'}
              kind="phrase"
              ownership={membershipManual ? 'manual' : 'automatic'}
              source={
                membershipManual
                  ? 'You’ll place entrants once registration closes.'
                  : 'Seeds spread 1, 2, 3, 3, 2, 1.'
              }
              // What placing entrants by hand COSTS, said on the row that costs it: the
              // snake keeps two players who met in a pool apart in the first knockout
              // round, and a hand-dealt pool cannot promise that.
              note={
                membershipManual
                  ? 'Repeat protection turns off when you assign pools by hand.'
                  : undefined
              }
              action={
                canEdit
                  ? membershipManual
                    ? {
                        label: 'Use snake',
                        onClick: () => own({ membershipMode: 'snake' }),
                      }
                    : {
                        label: 'Assign myself',
                        onClick: () => own({ membershipMode: 'manual' }),
                      }
                  : undefined
              }
            />
            {/* **K, and this is now the only place it is set** (chore 3e): it is a
                structural setting, so it moved off the Basics tab and in beside the other
                three (ADR 20260808). Which is why this row carries two slots the other
                three do not — the resolver's red, and the cut-draw freeze — both of which
                the Basics row it replaced already had. Dropping either in the move would
                have sent a refused save to a tab with nothing red on it, or offered a
                director a click that can only 409. */}
            <SettingRow
              name="Qualifiers per pool"
              hint="How many finishers from each pool reach the knockout."
              value={String(structure.qualifiersPerPool)}
              kind="number"
              unit="through from each pool"
              ownership={structure.sources.qualifiers.ownership}
              source={structure.sources.qualifiers.sentence}
              error={errors.qualifiersPerPool}
              freeze={qualifiersFreeze}
              entry={
                canEdit && ownership.qualifiersMode === 'manual'
                  ? {
                      // The event's own K — the manual slot for this setting. There is no
                      // `manual_qualifiers` on the wire: the stored count IS the slot.
                      value: event.qualifiersPerPool,
                      max: QUALIFIERS_PER_POOL_MAX,
                      onChange: (value) => own({}, value),
                    }
                  : undefined
              }
              action={
                canEdit
                  ? ownership.qualifiersMode === 'manual'
                    ? {
                        label: 'Use automatic',
                        // ⚠️ The mode, and ONLY the mode. Clearing K here would be a
                        // destructive `Use automatic` *and* an unsaveable event: the
                        // count is required on every `rr-then-ko` event, so the resolver
                        // would refuse the save and send the director to Basics.
                        onClick: () => own({ qualifiersMode: 'automatic' }),
                      }
                    : {
                        label: 'Set myself',
                        // Seeded from the derived count, which for a stored K the system
                        // was ignoring is a real change to the event's number — and the
                        // right one: it is what the row, the preview and the pool cards
                        // have all been showing.
                        onClick: () =>
                          own(
                            { qualifiersMode: 'manual' },
                            structure.qualifiersPerPool,
                          ),
                      }
                  : undefined
              }
            />
          </div>

          {/* Under the settings, in the left column: the notice is about the numbers
              directly above it. The preview in the right column states what the draw IS;
              this states the one thing worth saying about it. */}
          {issue !== null && (
            <div className="mt-5">
              <DrawIssuePanel issue={issue} />
            </div>
          )}
        </div>

        {/* The live preview's column. The preview is sticky inside it, so the draw stays
            on screen while the director scrolls the settings that change it — which
            works because a grid item stretches to the row's height by default. */}
        <div className="min-w-0" data-testid="draw-structure-preview-slot">
          <DrawPreview
            structure={structure}
            fieldSize={fieldSize}
            // ⚠️ The event's real pool ROWS, not `max(rows, derived)` as the reference
            // shows (ADR 20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-
            // count-is-a-projection). A director who takes the pool count and types 8
            // over four reservations must read `8 pools` in the equation and `4` in the
            // fact, and see the gap.
            poolReservationCount={event.pools.length}
            membershipMode={ownership.membershipMode}
            previewBasis={previewBasis}
          />
        </div>
      </div>
    </div>
  )
}
