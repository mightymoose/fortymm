import { Fragment } from 'react'

import { Overline } from '@/components/overline'

import type { DrawIssue } from './draw-issue'

export interface DrawIssuePanelProps {
  /** The issue to state, already chosen by `drawIssueFor`. The panel never picks: given
   * one it renders one, which is what keeps the precedence in a single place. */
  issue: DrawIssue
}

/**
 * The Draw structure tab's **issue panel** (#1320): one notice under the settings list,
 * saying the one thing that is true of the director's numbers.
 *
 * **It never picks.** Which of the three kinds is on screen is `drawIssueFor`'s
 * (`./draw-issue`), so the precedence lives in one place and this renders what it is
 * handed.
 *
 * ## Why it is not an `Alert`
 *
 * The reference gives `Can’t save` the role `alert` and gives the other two the role
 * `status`, so **the role is variant data** — a field of the same table that carries the
 * topline and the dot, exactly as `VERDICTS` works in `draw-preview.tsx`. `Alert`
 * (`components/ui/alert`) hardcodes `role="alert"`. Passing `role` through its prop
 * spread would work, and would leave the role as a default being fought rather than a
 * field being set. After overriding its `bg-card`, its padding and its two slot faces to
 * reach the tab's tokens there is about three utility classes of it left, so this is a
 * small purpose-built panel instead. It still composes the tab's primitives: `Overline`
 * for the topline, and the `--border-subtle` / `--bg-raised` / `--info` tokens the
 * preview beside it already uses.
 *
 * ## The meaning is the words, never the dot
 *
 * `Legal, but uneven` is visible text. The coloured dot is `aria-hidden` decoration on
 * top of it, so a reader who cannot separate blue from yellow reads the same notice
 * everyone else does.
 *
 * ## What this chore renders
 *
 * **Only the uneven variant.** `Can’t save` is chore 4c and `Needs your call` is chore
 * 5a — both come with fixes and `Apply` buttons that no derivation can supply, so
 * inventing their copy here would be inventing the fixes too.
 */
export const DrawIssuePanel = ({ issue }: DrawIssuePanelProps) => {
  // Chores 4c (impossible, role `alert`, red dot, up to two fixes) and 5a (disagreement,
  // role `status`, yellow dot, three fixes) render here. Until then the tab shows nothing
  // in those states rather than a half-written panel: the live preview beside it already
  // reads `This draw can’t work yet` / `Your numbers disagree`, so neither state is
  // silent.
  if (issue.kind !== 'uneven') return null

  return (
    // `status`, not `alert`: an uneven split is legal. It is announced when the reader
    // gets to it and never interrupts, it disables nothing, and saving and cutting stay
    // available — so it wears none of the warning tokens either.
    <div
      role="status"
      data-testid="draw-issue-panel"
      data-issue-kind={issue.kind}
      className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-raised)] px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-[color:var(--info)]"
        />
        {/* No colour of its own: `.fortymm-theme .fortymm-overline` is unlayered and
            beats a Tailwind text-colour utility set here anyway. */}
        <Overline as="span">Legal, but uneven</Overline>
      </div>

      {/* The tally the derivation counted, largest group first. Each string literal
          carries its own spaces — JSX drops the whitespace around a line break, and
          `2groups of6` is one reformat away from a text node written the other way. */}
      <p
        data-testid="draw-issue-panel-title"
        className="mt-1.5 text-[15px] leading-snug font-semibold text-[color:var(--fg-1)]"
      >
        {issue.distribution.map((tally, index) => (
          // Keyed by size: `tallySizes` counts each size once, so a size is unique in
          // the list and index keys would reorder wrongly as the field changes.
          <Fragment key={tally.size}>
            {index > 0 && ' · '}
            <span className="font-mono">{tally.groups}</span>
            {/* Pluralised, unlike `1 reservations` next door. That sentence stays
                unpluralised because a Python twin transcribes it against shared vectors;
                this title is built here from a `GroupSizeTally[]` and has no twin, and
                `1 group of 4 · 1 group of 3` (a field of 7 over 2 reservations) ships
                today. */}
            {tally.groups === 1 ? ' group of ' : ' groups of '}
            <span className="font-mono">{tally.size}</span>
          </Fragment>
        ))}
      </p>

      <p
        data-testid="draw-issue-panel-body"
        className="mt-1 text-[13px] leading-snug text-[color:var(--fg-3)]"
      >
        The bigger groups play more matches. Nothing has been silently reshaped.
      </p>
    </div>
  )
}
