import { Fragment } from 'react'

import { Overline } from '@/components/overline'
import { Button } from '@/components/ui/button'

import type { DrawIssue } from './draw-issue'
import type { DrawStructureFix } from './draw-issue-fix'

/**
 * The offered ways out, as a list of rows: a label, a detail line, and one `Apply`.
 *
 * **One list, two panels.** The refusal offers up to two and the disagreement offers three,
 * which is a `columns` apart and nothing else — and the a11y-critical part (the per-fix
 * `aria-label`, because every visible button reads only `Apply`) is exactly the part that
 * forks when identical markup is copied. This repo has measured that fork: see the
 * `interactiveElementsIn` note in `web-client/CLAUDE.md`, where one sweep copy-pasted three
 * ways left six of eight guards with a hole in them.
 *
 * Renders nothing for an empty list, which is the usual case: an uneven split has nothing
 * to fix, and a reader is offered nothing anywhere on this tab (ADR-0015).
 */
const FixList = ({
  fixes,
  columns,
  onApplyFix,
}: {
  fixes: DrawStructureFix[]
  /** The grid at `sm` and up — as many columns as the panel has fixes. Below `sm` they
   * stack: a row of a label, a detail line and a button does not fit a phone beside
   * another one. */
  columns: string
  onApplyFix: (fix: DrawStructureFix) => void
}) => {
  if (fixes.length === 0) return null
  return (
    <ul className={`mt-3 grid grid-cols-1 gap-2 ${columns}`}>
      {fixes.map((fix) => (
        // Keyed by the label, which is the fix: two fixes for one problem never read the
        // same, and an index key would reattach the wrong button the moment the problem
        // changed under it.
        <li
          key={fix.label}
          data-testid="draw-issue-fix"
          className="flex items-start justify-between gap-3 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)] px-3 py-2"
        >
          <div className="min-w-0">
            <p
              data-testid="draw-issue-fix-label"
              className="text-[13px] leading-snug font-semibold text-[color:var(--fg-1)]"
            >
              {fix.label}
            </p>
            <p
              data-testid="draw-issue-fix-detail"
              className="mt-0.5 text-[12px] leading-snug text-[color:var(--fg-3)]"
            >
              {fix.detail}
            </p>
          </div>
          <Button
            variant="link"
            size="sm"
            data-testid="draw-issue-fix-apply"
            className="h-auto shrink-0 p-0 text-[13px]"
            // Every one of these buttons says `Apply`, so the visible words alone name no
            // fix — and a list of buttons is how a screen-reader user meets them. The
            // visible word comes FIRST, so what a director says out loud to a voice-control
            // tool still matches (the `SettingRow` action's rule).
            aria-label={`Apply ${fix.label}`}
            onClick={() => onApplyFix(fix)}
          >
            Apply
          </Button>
        </li>
      ))}
    </ul>
  )
}

export interface DrawIssuePanelProps {
  /** The issue to state, already chosen by `drawIssueFor`. The panel never picks: given
   * one it renders one, which is what keeps the precedence in a single place. */
  issue: DrawIssue
  /**
   * The named ways out, already worked out by `impossibleFixes` or `disagreementFixes`
   * (`./draw-issue-fix`) — their labels, their detail lines, and the numbers they would
   * write.
   *
   * **Empty is a real answer, and it is the usual one**: an uneven split has nothing to
   * fix, and a reader (`canEdit: false`) is offered nothing anywhere on this tab (ADR-0015
   * — a read-only surface is a view, not a disabled form). The panel renders the fix list
   * it is handed and never derives one, for the same reason it never picks the kind.
   */
  fixes: DrawStructureFix[]
  /** Apply one. **The panel does not know what a fix does** — the tab routes it to the
   * pool rows, to the player limit on Basics, or to the qualifier count, through the same
   * seams the setting rows write through. */
  onApplyFix: (fix: DrawStructureFix) => void
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
 * for the topline, and the `--border-subtle` / `--bg-raised` / `--info` / `--loss` tokens
 * the preview beside it already uses.
 *
 * ## The meaning is the words, never the dot
 *
 * `Can’t save` and `Legal, but uneven` are visible text. The coloured dot is `aria-hidden`
 * decoration on top of them, so a reader who cannot separate red from blue reads the same
 * notice everyone else does.
 *
 * ## The three variants
 *
 * `Can’t save` reports a blocked act, so it is an `alert` and wears the refusal's colour.
 * `Needs your call` and `Legal, but uneven` are both `status`: neither disables anything,
 * and a draw whose numbers disagree still saves (`event-draw-structure.ts` — the gate reads
 * `impossibleProblems` only). What separates those two is that the disagreement is a
 * question — it carries three resolutions and a warning tint — while the uneven notice is
 * an observation and carries neither.
 */
export const DrawIssuePanel = ({
  issue,
  fixes,
  onApplyFix,
}: DrawIssuePanelProps) => {
  if (issue.kind === 'impossible') {
    return (
      // `alert`, not `status`: this one reports a **blocked act**. The save is unavailable
      // while it is on screen (`event-editor.tsx`), so it interrupts rather than waits to
      // be reached — the opposite call from the uneven notice below, and the reason the
      // role is variant data.
      <div
        role="alert"
        data-testid="draw-issue-panel"
        data-issue-kind={issue.kind}
        // Tinted, unlike the uneven notice's plain raised surface: the reference draws
        // this one in its refusal colour, border and field alike. The colour is on top of
        // the words, never instead of them — `Can’t save` is visible text.
        className="rounded-xl border border-[color:var(--loss)]/40 bg-[color:var(--loss)]/5 px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-[color:var(--loss)]"
          />
          {/* No colour of its own: `.fortymm-theme .fortymm-overline` is unlayered and
              beats a Tailwind text-colour utility set here anyway. */}
          <Overline as="span">Can’t save</Overline>
        </div>

        {/* The derivation's words, both of them — the cause and what to do about it. The
            panel writes neither: `deriveDrawStructure` names the first impossible
            competition, and naming it a second time here is how the two copies drift. */}
        <p
          data-testid="draw-issue-panel-title"
          className="mt-1.5 text-[15px] leading-snug font-semibold text-[color:var(--fg-1)]"
        >
          {issue.problem.title}
        </p>
        <p
          data-testid="draw-issue-panel-body"
          className="mt-1 text-[13px] leading-snug text-[color:var(--fg-3)]"
        >
          {issue.problem.body}
        </p>

        {/* Two ways out at most, so two columns. */}
        <FixList fixes={fixes} columns="sm:grid-cols-2" onApplyFix={onApplyFix} />
      </div>
    )
  }

  if (issue.kind === 'disagreement') {
    const { poolCount, poolSize, seats, fieldSize, direction, count } =
      issue.disagreement
    return (
      // `status`, not `alert`. **This is legal**: the save gate reads `impossibleProblems`
      // only, so a draw whose numbers disagree saves exactly as it stands. The director is
      // being asked a question, not stopped, and a question that interrupts what they were
      // reading would be answering it for them.
      <div
        role="status"
        data-testid="draw-issue-panel"
        data-issue-kind={issue.kind}
        // Tinted, like the refusal and unlike the uneven notice: the reference draws this
        // one in its `Your call` colour, the same `--warn` the preview's badge wears. On
        // top of the words, never instead of them.
        className="rounded-xl border border-[color:var(--warn)]/40 bg-[color:var(--warn)]/5 px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-[color:var(--warn)]"
          />
          {/* No colour of its own: `.fortymm-theme .fortymm-overline` is unlayered and
              beats a Tailwind text-colour utility set here anyway. */}
          <Overline as="span">Needs your call</Overline>
        </div>

        {/* ⚠️ **Both of the director's numbers, printed back at them unchanged**, and the
            product they actually make. Nothing on this panel adds a pool or enlarges one to
            make the arithmetic come out: the app states the standoff and offers three named
            ways out of it (ADR 20260808 — report, do not reshape).

            Unpluralised, so `1 pools of 5 seat 5.` is reachable. That is the reference's
            string, transcribed rather than improved, for the reason `Use 1 pools` is pinned
            in `./draw-issue-fix.test.ts`. */}
        <p
          data-testid="draw-issue-panel-title"
          className="mt-1.5 text-[15px] leading-snug font-semibold text-[color:var(--fg-1)]"
        >
          {`${poolCount} pools of ${poolSize} seat ${seats}. Your field is ${fieldSize}.`}
        </p>
        {/* The shortfall in the direction it actually runs — entrants with nowhere to go,
            or seats nobody fills. `direction` carries the sign so neither sentence has to
            read a negative number aloud. */}
        <p
          data-testid="draw-issue-panel-body"
          className="mt-1 text-[13px] leading-snug text-[color:var(--fg-3)]"
        >
          {direction === 'unseated'
            ? `${count} entrants have nowhere to go. We won’t change your numbers behind your back.`
            : `${count} seats would be empty. We won’t change your numbers behind your back.`}
        </p>

        {/* Three resolutions, so three columns. */}
        <FixList fixes={fixes} columns="sm:grid-cols-3" onApplyFix={onApplyFix} />
      </div>
    )
  }

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

      {/* The tally the derivation counted, largest pool first. Each string literal
          carries its own spaces — JSX drops the whitespace around a line break, and
          `2pools of6` is one reformat away from a text node written the other way. */}
      <p
        data-testid="draw-issue-panel-title"
        className="mt-1.5 text-[15px] leading-snug font-semibold text-[color:var(--fg-1)]"
      >
        {issue.distribution.map((tally, index) => (
          // Keyed by size: `tallySizes` counts each size once, so a size is unique in
          // the list and index keys would reorder wrongly as the field changes.
          <Fragment key={tally.size}>
            {index > 0 && ' · '}
            <span className="font-mono">{tally.pools}</span>
            {/* Pluralised, unlike `1 pool reservations` next door. That sentence stays
                unpluralised because a Python twin transcribes it against shared vectors;
                this title is built here from a `PoolSizeTally[]` and has no twin, and
                `1 pool of 4 · 1 pool of 3` (a field of 7 over 2 reservations) ships
                today. */}
            {tally.pools === 1 ? ' pool of ' : ' pools of '}
            <span className="font-mono">{tally.size}</span>
          </Fragment>
        ))}
      </p>

      <p
        data-testid="draw-issue-panel-body"
        className="mt-1 text-[13px] leading-snug text-[color:var(--fg-3)]"
      >
        The bigger pools play more matches. Nothing has been silently reshaped.
      </p>
    </div>
  )
}
