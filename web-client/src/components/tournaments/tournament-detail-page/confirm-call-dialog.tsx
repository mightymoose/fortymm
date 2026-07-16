import { useRef } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/** One placement as the players would be told it: the table's catalogue label and the
 * `HH:MM` predicted start — `null` time for a table-only placement (there is a table to
 * go to, no time yet). */
export interface PlacementSummary {
  tableLabel: string
  time: string | null
}

/**
 * What confirming would DO — the dialog's whole content, as a sum type (no tri-state
 * booleans): each variant carries exactly the context its copy names, so a call cannot
 * be rendered without its destination nor a correction without what the players were
 * told (ADR "the schedule is solved; the call is pinned").
 */
export type CallConsequence =
  | { variant: 'call'; to: PlacementSummary }
  | {
      variant: 'correction-move'
      told: PlacementSummary
      to: PlacementSummary
      notifiedCount: number
    }
  | { variant: 'correction-cancel'; told: PlacementSummary; notifiedCount: number }

export interface ConfirmCallDialogProps {
  open: boolean
  /** The pairing being called/corrected — `player.1 vs player.4`. */
  matchLabel: string
  consequence: CallConsequence
  onConfirm: () => void
  onCancel: () => void
}

/** `T1 at 10:30`, or just `T1` for a table-only placement. */
const summaryLabel = (s: PlacementSummary) =>
  s.time ? `${s.tableLabel} at ${s.time}` : s.tableLabel

const Strong = ({ children }: { children: React.ReactNode }) => (
  <span className="font-semibold text-[color:var(--fg-1)]">{children}</span>
)

/**
 * The consequence-stating confirm on a **notifying** placement (ADR "the schedule is
 * solved; the call is pinned": while live, placing a fixture *is* calling it, so the UI
 * prices a director's click before it spends the players' attention). Three variants:
 * calling an untold fixture, moving a told one (a correction), and clearing a told one
 * (a cancellation). Pre-live placements never reach this dialog — they are silent.
 *
 * The confirm button states the consequence — `Call the match` / `Move and notify` /
 * `Cancel the call` — never a bare "OK"; Escape and the overlay read as the cancel
 * (nothing is sent). Focus is trapped by the design system's `AlertDialog`.
 */
export const ConfirmCallDialog = ({
  open,
  matchLabel,
  consequence,
  onConfirm,
  onCancel,
}: ConfirmCallDialogProps) => {
  // Radix closes the dialog itself on the ACTION click too, and reports it through
  // the same onOpenChange(false) as Escape/overlay — remember a confirm so its
  // close is not double-reported as a cancel (a confirm is not a cancel).
  const confirmed = useRef(false)

  const body = (() => {
    switch (consequence.variant) {
      case 'call':
        return {
          title: 'Call this match?',
          description: (
            <>
              This tournament is live, so placing a match <Strong>calls</Strong> it:
              both players of <Strong>{matchLabel}</Strong> will be notified to play
              on <Strong>{summaryLabel(consequence.to)}</Strong>.
            </>
          ),
          notifiedCount: null,
          confirmLabel: 'Call the match',
          confirmVariant: 'default' as const,
        }
      case 'correction-move':
        return {
          title: 'Move a called match?',
          description: (
            <>
              Both players of <Strong>{matchLabel}</Strong> were told{' '}
              <Strong>{summaryLabel(consequence.told)}</Strong>. Moving it to{' '}
              <Strong>{summaryLabel(consequence.to)}</Strong> sends both a
              correction.
            </>
          ),
          notifiedCount: consequence.notifiedCount,
          confirmLabel: 'Move and notify',
          confirmVariant: 'default' as const,
        }
      case 'correction-cancel':
        return {
          title: 'Cancel this call?',
          description: (
            <>
              Both players of <Strong>{matchLabel}</Strong> were told{' '}
              <Strong>{summaryLabel(consequence.told)}</Strong>. Clearing the
              placement tells both players the match is off this table.
            </>
          ),
          notifiedCount: consequence.notifiedCount,
          confirmLabel: 'Cancel the call',
          confirmVariant: 'destructive' as const,
        }
      default: {
        const exhaustive: never = consequence
        return exhaustive
      }
    }
  })()

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        // Every OTHER close — Go back, overlay click, Escape — reads as the
        // cancel: a stray dismiss must never notify anyone. The flag is
        // consumed per close, so a dialog a parent keeps mounted stays honest.
        if (!confirmed.current) onCancel()
        confirmed.current = false
      }}
    >
      <AlertDialogContent data-testid="confirm-call-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{body.title}</AlertDialogTitle>
          <AlertDialogDescription>{body.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {body.notifiedCount !== null && (
          <p
            data-testid="confirm-call-notified"
            className="font-mono text-[12px] tabular-nums text-[color:var(--warn)]"
          >
            They&apos;ve been notified {body.notifiedCount}&times; already.
          </p>
        )}
        <AlertDialogFooter>
          {/* No onClick of its own: the cancel is reported once, through
              onOpenChange, the same channel Escape and the overlay use. */}
          <AlertDialogCancel data-testid="confirm-call-cancel">
            Go back
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="confirm-call-confirm"
            variant={body.confirmVariant}
            onClick={() => {
              confirmed.current = true
              onConfirm()
            }}
          >
            {body.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
