import { useId } from 'react'

import { Overline } from '@/components/overline'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import type { PoolMembershipMode } from '../../../data/draw-ownership'
import { poolLetter, type DrawStructure } from '../../../data/draw-structure'
import { PoolCard } from './draw-preview/pool-card'

/** The `Membership` fact, in the reference's words — two of them, because the fact is a
 * summary and the setting row one column over is where the sentence is. */
const MEMBERSHIP_FACT: Record<PoolMembershipMode, string> = {
  snake: 'Snake',
  manual: 'By hand at cut',
}

/** How many pool cards the preview draws. The reference stops at eight, and so does
 * this: the equation directly above already states the pool count, so a twelve-pool draw
 * reads `12 pools` over eight cards rather than losing the number. The cards are a shape,
 * not an inventory. */
const MAX_POOL_CARDS = 8

/** The three states the preview can be in, in the words the reference uses. **The
 * heading and the badge are one decision**, so they are one table — split across two
 * conditionals they would eventually disagree, and a `Sound` badge over
 * `This draw can’t work yet` is worse than either alone. */
const VERDICTS = {
  impossible: {
    heading: 'This draw can’t work yet',
    badge: 'Impossible',
    badgeClass: 'border-[color:var(--loss)]/50 text-[color:var(--loss)]',
  },
  disagreement: {
    heading: 'Your numbers disagree',
    badge: 'Your call',
    badgeClass: 'border-[color:var(--warn)]/50 text-[color:var(--warn)]',
  },
  sound: {
    heading: 'Ready to save',
    badge: 'Sound',
    badgeClass: 'border-[color:var(--serve-500)]/50 text-[color:var(--serve-500)]',
  },
} as const

export interface DrawPreviewProps {
  /** The whole derivation, already done. **Every number the preview shows is read off
   * this** — nothing here divides, rounds or counts. */
  structure: DrawStructure
  /** The field the derivation ran against, so the equation states its own left-hand
   * side. */
  fieldSize: number
  /**
   * How many pool rows the event actually has.
   *
   * ⚠️ **Not `max(reservations, derived)`.** The reference shows the larger of the two
   * and moves on; ADR
   * `20260808-an-events-pool-count-is-its-pool-rows-and-a-derived-count-is-a-projection`
   * refuses that, because the `max()` hides the one thing worth reporting. A director
   * with four pool rows whose structure needs eight must read `8 pools` in the equation
   * and `4` in this fact, and see the gap.
   */
  poolReservationCount: number
  /** How entrants will reach their pools — the event's stored mode (ADR 20260808). The
   * mode itself rather than a label, because the fact's two words are the preview's own
   * copy (`MEMBERSHIP_FACT`) and shorter than the setting row's: the row says
   * `Snake automatically`, the fact says `Snake`. */
  membershipMode: PoolMembershipMode
  /** Where the preview field came from, in words — `32-player cap`, or the honest
   * sentence for an event with no cap. Built by `previewBasisLabel` **at the caller**, so
   * the heading block and this fact are one call and cannot come apart. */
  previewBasis: string
}

/**
 * The Draw structure tab's **live preview** (#1320): the draw as it stands, in one
 * sticky column beside the settings that produce it.
 *
 * ## Why it is one panel
 *
 * There is exactly one verdict on this tab, and it is here. The left column's notices
 * (uneven, disagreement, impossible) explain and offer fixes; this says what the draw
 * currently *is*. A second summary anywhere would give a director two places to look and
 * one of them would be stale.
 *
 * ## Why it announces itself
 *
 * The numbers move on every keystroke in the settings next door, and a preview that
 * silently swaps its text is a preview a screen-reader user never learns changed. The
 * body is therefore a `status` region — polite, and **not** atomic: an atomic region
 * would re-read the equation, all eight pools, the knockout and the three facts every
 * time a single digit moved.
 *
 * ## What is not here
 *
 * The reference ends with a `Preview cut-time assignment →` link. That screen is #1324,
 * so the link is absent rather than stubbed — a dead link is the unexplained dead end
 * ADR-0015 forbids. The reference also carries a `Repeat protection is off` block under
 * the facts when membership is manual; the Membership setting row states that cost
 * already, and the block is a later chore.
 */
export const DrawPreview = ({
  structure,
  fieldSize,
  poolReservationCount,
  membershipMode,
  previewBasis,
}: DrawPreviewProps) => {
  const overlineId = useId()

  // The precedence is the reference's, and it is the order a director can act in: a draw
  // that cannot be played is not "your call".
  const verdict =
    structure.impossibleProblems.length > 0
      ? VERDICTS.impossible
      : structure.disagreement !== null
        ? VERDICTS.disagreement
        : VERDICTS.sound

  // Read off the derived sizes rather than divided out again — the pools are routinely
  // unequal, and `8` where the draw holds `6–5` would be the silent reshaping #1320
  // exists to remove.
  const smallestPool = Math.min(...structure.poolSizes)
  const largestPool = Math.max(...structure.poolSizes)
  const sizeLabel =
    smallestPool === largestPool
      ? String(smallestPool)
      : `${smallestPool}–${largestPool}`

  const byes = structure.firstRoundByes
  const byesLine =
    byes === 0
      ? 'No first-round byes'
      : `${byes} first-round ${byes === 1 ? 'bye' : 'byes'}`

  // Three facts about the draw that are not in the picture above it. Only a bare figure
  // takes the mono face: `Preview basis` is `32-player cap` for a capped event but a
  // whole sentence for an uncapped one, and the heading block already sets that same
  // sentence in the UI face.
  const facts = [
    {
      term: 'Pool reservations',
      value: String(poolReservationCount),
      mono: true,
    },
    { term: 'Membership', value: MEMBERSHIP_FACT[membershipMode], mono: false },
    { term: 'Preview basis', value: previewBasis, mono: false },
  ]

  return (
    // Sticky, so the draw stays on screen while the director scrolls the four settings
    // that change it — the whole point of putting the two side by side.
    <section
      aria-labelledby={overlineId}
      data-testid="draw-preview"
      className="sticky top-0 flex flex-col gap-3 rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)] p-4"
    >
      <div
        role="status"
        aria-atomic="false"
        className="flex min-w-0 flex-col gap-3"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/* No colour of its own: `.fortymm-theme .fortymm-overline` is unlayered,
                so it beats any Tailwind text-colour utility set here, and the muted
                grey it gives is the one the reference uses. */}
            <Overline id={overlineId}>The draw as it stands</Overline>
            <h4
              data-testid="draw-preview-verdict"
              className="mt-1 text-[17px] leading-tight font-semibold text-[color:var(--fg-1)]"
            >
              {verdict.heading}
            </h4>
          </div>
          <Badge
            data-testid="draw-preview-badge"
            variant="outline"
            className={cn(
              'shrink-0 text-[10px] font-semibold tracking-[0.1em] uppercase',
              verdict.badgeClass,
            )}
          >
            {verdict.badge}
          </Badge>
        </div>

        {/* The whole draw in one line. Each string literal carries its own spaces —
            JSX drops the whitespace around a line break, and `32players` is one
            reformat away from a text node written the other way. */}
        <p
          data-testid="draw-preview-equation"
          className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-raised)] px-3 py-2 text-center text-[12px] text-[color:var(--fg-3)]"
        >
          <span className="font-mono text-[15px] font-semibold text-[color:var(--fg-1)]">
            {fieldSize}
          </span>
          {' players ÷ '}
          <span className="font-mono text-[15px] font-semibold text-[color:var(--fg-1)]">
            {structure.poolCount}
          </span>
          {' pools = '}
          <span className="font-mono text-[15px] font-semibold text-[color:var(--fg-1)]">
            {sizeLabel}
          </span>
          {' per pool'}
        </p>

        {/* Named, because eight identically-shaped cards are otherwise a wall of
            numbers a screen reader cannot introduce. */}
        {/* Two across: the preview column is 280px at its widest, and a third card
            would squeeze the figures below the size the mono face is set at. */}
        <ul aria-label="Projected pools" className="grid grid-cols-2 gap-2">
          {structure.poolSizes.slice(0, MAX_POOL_CARDS).map((size, index) => (
            <PoolCard
              key={poolLetter(index)}
              letter={poolLetter(index)}
              size={size}
              qualifiers={structure.qualifiersPerPool}
            />
          ))}
        </ul>

        {/* Decorative: the pools feeding the knockout is already said in words below. */}
        <p
          aria-hidden="true"
          className="text-center text-[13px] leading-none text-[color:var(--fg-3)]"
        >
          ↓
        </p>

        <div
          data-testid="draw-preview-knockout"
          className="flex items-start justify-between gap-3 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-raised)] px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-[10px] font-semibold tracking-[0.14em] text-[color:var(--fg-3)] uppercase">
              Knockout
            </div>
            <p className="mt-0.5 font-mono text-[15px] font-semibold text-[color:var(--fg-1)]">
              {structure.knockoutBracketSize}-player bracket
            </p>
          </div>
          <div className="shrink-0 text-right text-[11px] text-[color:var(--fg-3)]">
            <p>{byesLine}</p>
            {/* Not pluralised, deliberately: the reference does not pluralise this line
                and `data/draw-structure.ts` records why an unasked-for improvement here
                is drift against the Python twin. */}
            <p>{structure.poolMatchCount} pool matches</p>
          </div>
        </div>

        <dl className="mt-1 border-t border-[color:var(--border-subtle)]">
          {facts.map(({ term, value, mono }) => (
            <div
              key={term}
              className="flex items-baseline justify-between gap-3 border-b border-[color:var(--border-subtle)] py-1.5"
            >
              <dt className="text-[12px] text-[color:var(--fg-3)]">{term}</dt>
              <dd
                className={cn(
                  'text-[12px] text-[color:var(--fg-1)]',
                  mono && 'font-mono',
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Outside the live region: it never changes, and a region that re-read it on
          every keystroke would bury the numbers that did. */}
      <p
        data-testid="draw-preview-foot"
        className="text-[11px] leading-snug text-[color:var(--fg-3)]"
      >
        Entrants are placed only when registration closes and you cut the draw.
      </p>
    </section>
  )
}
