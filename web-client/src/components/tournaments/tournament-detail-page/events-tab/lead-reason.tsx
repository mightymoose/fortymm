import { cn } from '@/lib/utils'

export interface LeadReasonProps {
  /** The state, in a few words ("Entries locked", "No one has entered yet.") —
   * emphasised, because it is the fact the reader came for. */
  lead: string
  /** Why — the cause behind the lead, in the muted voice. */
  reason: string
  /**
   * `inline` lets the lead open the sentence and the reason run on after it (the
   * roster's full-width rows); `stacked` puts the lead on its own line (the entry
   * control's narrow, right-aligned column, where an inline lead would tangle
   * with its reason).
   *
   * A layout knob, not a semantic one — which is exactly why it is the *only*
   * thing that differs between the three call sites. The voice (the size, the
   * muted reason, the emphasised lead) is not theirs to choose.
   */
  layout?: 'inline' | 'stacked'
  /** Placement — margins, width, alignment. The caller owns where it sits. */
  className?: string
  testId?: string
}

/**
 * The event card's **lead + reason** notice: a state in a few emphasised words,
 * and the cause behind it in the muted voice beneath.
 *
 * It is the card's way of saying "there is nothing to do here, and here is why" —
 * which happens in three places that used to hand-roll the same paragraph three
 * times (and had already drifted a font size apart): the roster's two designed
 * empty states (nobody has entered yet / this event cannot be entered at all —
 * `EntrantsList`), and the closed registration window (`EnterEventControl`).
 *
 * Always inert text, **never a disabled button** — a control that cannot be used
 * is an unexplained dead end, and a state with a reason is not a dead end at all
 * (ADR 0015, "hide mutating affordances"; "empty is a designed data state, never a
 * thrown one").
 *
 * This is deliberately NOT `components/tournaments/empty-state.tsx`: that is the
 * dashed, full-panel "this whole section is empty" variant. This one lives inside
 * a card that is otherwise entirely alive.
 */
export const LeadReason = ({
  lead,
  reason,
  layout = 'inline',
  className,
  testId,
}: LeadReasonProps) => (
  <p
    data-testid={testId}
    className={cn(
      'text-[13px] leading-snug text-[color:var(--fg-3)]',
      className,
    )}
  >
    <span
      className={cn(
        'font-medium text-[color:var(--fg-2)]',
        layout === 'stacked' && 'block',
      )}
    >
      {lead}
    </span>
    {layout === 'inline' ? ' ' : ''}
    {reason}
  </p>
)
