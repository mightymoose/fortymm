import { Overline } from '@/components/overline'
import { Button } from '@/components/ui/button'

import { deriveDrawStructure } from '../../data/draw-structure'
import type { TournamentEvent } from '../../data/types'
import { drawIssueFor } from './draw-structure-section/draw-issue'
import { DrawIssuePanel } from './draw-structure-section/draw-issue-panel'
import { DrawPreview } from './draw-structure-section/draw-preview'
import {
  previewBasisLabel,
  previewFieldSize,
} from './draw-structure-section/preview-field'
import { SettingRow } from './draw-structure-section/setting-row'

export interface DrawStructureSectionProps {
  /**
   * The event as the editor's **live draft** has it, so the tab recomputes as the
   * director edits the player limit, adds a reservation on the tabs next door, or
   * types a qualifier count on Basics (#1425).
   *
   * ⚠️ Only three fields are read — `maxPlayers`, `qualifiersPerGroup`, and
   * `reservations.length` — and the third is read as a *count* deliberately. The
   * editor's draft carries the form's `reservations`, which are `ReservationEntry`
   * diffs rather than the read model's `Reservation` rows (ADR 20260801); the length is
   * the same either way, and nothing else here may touch a reservation's insides.
   */
  event: TournamentEvent
  /**
   * Take the director to the Basics tab, where the player limit that sizes this preview
   * lives.
   *
   * A button, not a `<Link>`: Basics is a sibling tab inside this same sheet, so "go
   * there" is editor state and not navigation. A link would leave the page and lose the
   * unsaved draft.
   */
  onGoToBasics: () => void
}

/**
 * The event editor's **Draw structure** tab (#1320) — the four structural settings of a
 * round-robin-then-knockout draw, read out as the system currently derives them.
 *
 * ## Why the tab exists
 *
 * A director controls one and a half of these four settings today, and nothing on any
 * tab states the other two (ADR 20260808). #1320 records a real director who set one
 * group and one qualifier per group, sent one player to the bracket, and was refused
 * with a message that named the wrong cause. This tab states every number and says
 * where it came from, so the shape of the draw is readable before it is cut.
 *
 * ## What this chore renders, and what it does not
 *
 * **Three settings are `Automatic` and one is yours.** The group count, size and
 * membership are derived; the qualifier count is the number the director typed on
 * Basics (#1425), read back live through the same derivation — and until they type
 * one, that row reads as unset rather than inventing a figure. The `Set myself` /
 * `Use automatic` action and the numeric input arrive with the ownership modes (chore
 * 3c) — and they are *absent* until then, never a disabled box, which is the
 * unexplained dead end ADR-0015 forbids.
 *
 * The right column carries the live preview (`DrawPreview`) — **the tab's one verdict**,
 * and the only summary of the draw anywhere on it. The uneven / disagreement /
 * impossible *notices*, which explain those states and offer fixes, land under the
 * settings in this left column as one `DrawIssuePanel`. **Only the uneven one is built**:
 * `Can’t save` is chore 4c and `Needs your call` is chore 5a, and both come with `Apply`
 * fixes. The Group size row carries its own uneven copy either way (`{min}–{max}
 * players · uneven`), because that is row copy and not a panel.
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
  onGoToBasics,
}: DrawStructureSectionProps) => {
  const fieldSize = previewFieldSize(event.maxPlayers)
  // ONE call, two readers — the heading block and the preview's `Preview basis` fact.
  // Called twice they could eventually be called with different arguments, and two
  // sentences about the same number is exactly the confusion #1320 removes.
  const previewBasis = previewBasisLabel(event.maxPlayers)
  // The derivation deliberately does NOT read the event's reservation rows (#1386): the
  // automatic group count derives from the default group size, so adding or removing a
  // reservation changes no derived number. The preview still states the real rows — see
  // the `reservationCount` prop below, which is the one reader that keeps them.
  const structure = deriveDrawStructure({
    previewFieldSize: fieldSize,
    // The group count and size are still all the system's: nothing writes an ownership
    // mode for either yet.
    groupCountMode: 'automatic',
    manualGroupCount: null,
    groupSizeMode: 'automatic',
    manualGroupSize: null,
    // #1425: the qualifier count is the director's OWN number, typed on Basics and held
    // by the live draft. A number reads as `Yours`; an empty field reads as unset — it
    // is never fed to the automatic rule, which would invent a number the event does
    // not hold and badge it `Automatic`.
    qualifiersMode: event.qualifiersPerGroup === null ? 'unset' : 'manual',
    manualQualifiers: event.qualifiersPerGroup,
  })

  // Read off the derived sizes rather than divided out again — the groups are routinely
  // unequal (22 across 5 is `5, 5, 4, 4, 4`) and the uneven case is a first-class state.
  const smallestGroup = Math.min(...structure.groupSizes)
  const largestGroup = Math.max(...structure.groupSizes)
  const uneven = smallestGroup !== largestGroup

  // One fact flips the qualifiers row's whole shape — number vs phrase, unit, badge,
  // source sentence — so it is read once here rather than asked three times in the JSX
  // below (the same one-constant pattern `group-card.tsx` uses).
  const qualifiersUnset = structure.sources.qualifiers.ownership === 'unset'

  // The ONE notice the tab shows, chosen in the reference's order — impossible, then
  // disagreement, then uneven. The derivation reports all three independently and more
  // than one can hold at once (8 players across 6 reservations is an uneven split whose
  // last four groups have one player each), so the choice is `drawIssueFor`'s and this
  // tab never re-derives it.
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
            Groups play all-play-all. The top finishers move into a knockout
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
            <Button
              variant="link"
              size="sm"
              className="mt-1 h-auto p-0 text-[12px]"
              onClick={onGoToBasics}
            >
              Change in Basics
            </Button>
          </div>

          {/* ONE list with dividers, not one card per row. The divider is the list's, so
              a row contributes no border of its own and the four settings read as one
              draw rather than as four unrelated panels. */}
          <div className="mt-5 divide-y divide-[color:var(--border-subtle)] border-t border-[color:var(--border-subtle)]">
            <SettingRow
              name="Group count"
              hint="How many groups the field splits into. Each group's reservation also books its tables and time window."
              value={String(structure.groupCount)}
              kind="number"
              unit={structure.groupCount === 1 ? 'group' : 'groups'}
              ownership={structure.sources.groupCount.ownership}
              source={structure.sources.groupCount.sentence}
            />
            {/* The uneven split is this row's own copy, not the 2d notice: `{min}–{max}`
                with the unit saying so out loud. An en dash, and a middle dot before
                `uneven` — both the reference's glyphs. */}
            <SettingRow
              name="Group size"
              hint="The target number of players in each group."
              value={uneven ? `${smallestGroup}–${largestGroup}` : String(smallestGroup)}
              kind="number"
              unit={uneven ? 'players · uneven' : 'players per group'}
              ownership={structure.sources.groupSize.ownership}
              source={structure.sources.groupSize.sentence}
            />
            {/* Membership has no number, so `deriveDrawStructure` says nothing about it
                (its `DrawStructureSources` omits it by design). The row reads its mode
                off the event — and nothing stores one yet, so it is the snake, which is
                what `_snake()` in `api/app/draws.py` already does on every cut. */}
            <SettingRow
              name="Membership"
              hint="Who lands in each group. Entrants do not exist until you cut the draw."
              value="Snake automatically"
              kind="phrase"
              ownership="automatic"
              source="Seeds spread 1, 2, 3, 3, 2, 1."
            />
            {/* The SAME number Basics holds — the draft's live value, read back through
                the derivation (#1425). Until the director types one, the row is a phrase
                like Membership's: no number, no unit, no invented `Automatic` figure. */}
            <SettingRow
              name="Qualifiers per group"
              hint="How many finishers from each group reach the knockout."
              value={
                qualifiersUnset ? 'Not set' : String(structure.qualifiersPerGroup)
              }
              kind={qualifiersUnset ? 'phrase' : 'number'}
              unit={qualifiersUnset ? undefined : 'through from each group'}
              ownership={structure.sources.qualifiers.ownership}
              source={structure.sources.qualifiers.sentence}
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
            // ⚠️ The event's real reservation ROWS, not `max(rows, derived)` as the
            // reference shows (ADR 20260808, the group-count-is-group-rows-and-a-
            // derived-count-is-a-projection). Nothing sets a manual group count this
            // chore, so the two are equal today; taking the max would hide the gap the
            // moment chore 3c lets a director type one.
            reservationCount={event.reservations.length}
            previewBasis={previewBasis}
          />
        </div>
      </div>
    </div>
  )
}
