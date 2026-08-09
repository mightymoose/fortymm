import { Overline } from '@/components/overline'
import { Button } from '@/components/ui/button'

import { deriveDrawStructure } from '../../data/draw-structure'
import type { TournamentEvent } from '../../data/types'
import {
  previewBasisLabel,
  previewFieldSize,
} from './draw-structure-section/preview-field'
import { SettingRow } from './draw-structure-section/setting-row'

export interface DrawStructureSectionProps {
  /**
   * The event as the editor's **live draft** has it, so the tab recomputes as the
   * director edits the player limit or adds a pool on the tabs next door.
   *
   * ⚠️ Only two fields are read — `maxPlayers` and `pools.length` — and the second is
   * read as a *count* deliberately. The editor's draft carries the form's `pools`, which
   * are `PoolEntry` diffs rather than the read model's `Pool` rows (ADR 20260801); the
   * length is the same either way, and nothing else here may touch a pool's insides.
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
 * pool and one qualifier per pool, sent one player to the bracket, and was refused with
 * a message that named the wrong cause. This tab states every number and says where it
 * came from, so the shape of the draw is readable before it is cut.
 *
 * ## What this chore renders, and what it does not
 *
 * **Every setting is `Automatic`, and every value is text.** Nothing stores an ownership
 * mode yet, so the derivation is fed all-automatic and the rows read out what today's
 * behaviour already does. The `Set myself` / `Use automatic` action and the numeric
 * input arrive with the ownership modes (chore 3c) — and they are *absent* until then,
 * never a disabled box, which is the unexplained dead end ADR-0015 forbids.
 *
 * The right column is a **slot for the live preview** (chore 2c), and the uneven /
 * disagreement / impossible notices are chore 2d. What this tab already carries of them
 * is the Pool size row's own copy: an uneven split reads `{min}–{max} players · uneven`,
 * because that is row copy and not a panel.
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
  const structure = deriveDrawStructure({
    previewFieldSize: fieldSize,
    // One pool reservation is one pool — today's behaviour, and the automatic source of
    // the pool count (ADR 20260808).
    poolReservationCount: event.pools.length,
    // All four settings are the system's this chore: nothing writes an ownership mode
    // yet, so there is no manual number for any of them to hold.
    poolCountMode: 'automatic',
    manualPoolCount: null,
    poolSizeMode: 'automatic',
    manualPoolSize: null,
    qualifiersMode: 'automatic',
    manualQualifiers: null,
  })

  // Read off the derived sizes rather than divided out again — the pools are routinely
  // unequal (22 across 4 is `6, 6, 5, 5`) and the uneven case is a first-class state.
  const smallestPool = Math.min(...structure.poolSizes)
  const largestPool = Math.max(...structure.poolSizes)
  const uneven = smallestPool !== largestPool

  return (
    <div className="flex flex-col gap-6" data-testid="draw-structure-section">
      {/* **Stacked below `sm`, side by side above it** — the same breakpoint the sheet
          itself switches on (`w-full sm:w-[820px]`). A grid item's `min-width` is
          `auto`, so `minmax(0, …)` on both tracks is what keeps a long source sentence
          from widening the column past the sheet and hiding behind a horizontal
          scrollbar nothing advertises (the bug this editor has shipped twice). */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
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
              {previewBasisLabel(event.maxPlayers)}
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
              name="Pool count"
              hint="How many pools the field splits into. Each pool also books its tables and time window."
              value={String(structure.poolCount)}
              kind="number"
              unit={structure.poolCount === 1 ? 'pool' : 'pools'}
              ownership={structure.sources.poolCount.ownership}
              source={structure.sources.poolCount.sentence}
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
            />
            {/* Membership has no number, so `deriveDrawStructure` says nothing about it
                (its `DrawStructureSources` omits it by design). The row reads its mode
                off the event — and nothing stores one yet, so it is the snake, which is
                what `_snake()` in `api/app/draws.py` already does on every cut. */}
            <SettingRow
              name="Membership"
              hint="Who lands in each pool. Entrants do not exist until you cut the draw."
              value="Snake automatically"
              kind="phrase"
              ownership="automatic"
              source="Seeds spread 1, 2, 3, 3, 2, 1."
            />
            {/* ⚠️ Still on Basics as well, this slice. Chore 3e moves it here for good;
                until then the director sees the stored K on Basics and the DERIVED one
                here, and the two can disagree. That is deliberate and temporary. */}
            <SettingRow
              name="Qualifiers per pool"
              hint="How many finishers from each pool reach the knockout."
              value={String(structure.qualifiersPerPool)}
              kind="number"
              unit="through from each pool"
              ownership={structure.sources.qualifiers.ownership}
              source={structure.sources.qualifiers.sentence}
            />
          </div>
        </div>

        {/* The live preview's column (chore 2c). Empty on purpose and empty to a screen
            reader too — a placeholder that said "coming soon" would be a promise this
            tab is not making to a director. */}
        <div className="min-w-0" data-testid="draw-structure-preview-slot" />
      </div>
    </div>
  )
}
