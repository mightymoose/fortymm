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

/**
 * What confirming would SPEND — the dialog's whole content, as a sum type (no bag of
 * optional props): each variant carries exactly the context its copy names, so a draw
 * act cannot be rendered without the event whose pairings it discards, nor a lifecycle
 * act without the tournament it moves (ADR "a confirm prices an irreversible act, a
 * freeze explains an illegal one").
 *
 * Five acts, of two kinds. The two **draw** acts discard a standing draw and the schedule
 * solved on it. The three **lifecycle** edges are the forward-only path a tournament walks
 * — `draft → published → live → archived` — with no edge back and `archived` terminal, so
 * every one of them is one-way too.
 *
 * The `never` default in the body switch is what keeps the union honest: a variant added
 * here is a **type error** until it has copy of its own, rather than a dialog that
 * silently renders another act's sentence.
 *
 * Note what is NOT shared across the variants: there is no top-level `eventName` prop.
 * A lifecycle act is about a *tournament*, not an event, so hoisting either name would
 * oblige the other kind of variant to supply a field its copy never says.
 */
/** The acts that belong to an event's **draw**. Named apart from the whole union
 * because the draw panel owns exactly these and must be able to say so: a component
 * typed on `IrreversibleActConsequence` inherits every variant the union later grows,
 * so its own exhaustive switch breaks in a slice that never mentions it, and its state
 * can hold an act it has no case for. The narrow alias is what keeps "make illegal
 * states unrepresentable" pointing outward instead of at ourselves. */
export type DrawActConsequence =
  | { variant: 'recut-draw'; eventName: string }
  | { variant: 'delete-draw'; eventName: string }
  | { variant: 'publish-tournament'; tournamentName: string }
  | { variant: 'start-tournament'; tournamentName: string }
  | { variant: 'end-tournament'; tournamentName: string }

export type IrreversibleActConsequence = DrawActConsequence

export interface ConfirmIrreversibleActDialogProps {
  open: boolean
  consequence: IrreversibleActConsequence
  onConfirm: () => void
  onCancel: () => void
}

const Strong = ({ children }: { children: React.ReactNode }) => (
  <span className="font-semibold text-[color:var(--fg-1)]">{children}</span>
)

/**
 * The consequence-stating confirm on an act a director **cannot undo**: the two draw acts
 * (re-cutting a standing draw, deleting one) and the three lifecycle edges (publish,
 * start, end). The first cut of a draw is exempt by design — it is constructive and
 * re-cuttable, and a confirm there would only train the director to click through the
 * ones that matter.
 *
 * The body names what the click *spends*, in the director's own terms, and names the
 * thing it spends it on: the **event** for a draw act (the Events tab renders one card
 * per event, so "the draw" alone is ambiguous the moment a tournament has more than one),
 * the **tournament** for a lifecycle one.
 *
 * The confirm button carries the act's own verb — `Re-cut the draw`, `Start the
 * tournament` — never a bare "OK" or "Confirm". Cancel is a no-op, and so is Escape —
 * nothing fires.
 *
 * A click on the **overlay does nothing at all**: Radix's `AlertDialogContent`
 * `preventDefault`s both `onPointerDownOutside` and `onInteractOutside`, so the dialog
 * neither closes nor reports a cancel. That is the behaviour a consequential confirm
 * wants — a mis-click beside "Delete this draw?" must not dismiss it — so do not
 * "restore" an outside-click dismissal here. It is a property of `AlertDialog`, and it is
 * the reason to use `AlertDialog` rather than `Dialog` for a decision.
 *
 * Focus is trapped, and Radix's own `onOpenAutoFocus` lands it on **Go back** — the safe
 * default when the other button spends something that does not come back.
 *
 * ## Why only two of the five wear the destructive treatment
 *
 * The confirm's `variant` is decided by the same `switch` that writes the copy, so a new
 * variant cannot acquire a sentence without also answering for how its button looks.
 * `destructive` is reserved for the acts that **throw work away** — the two draw verbs
 * discard pairings and the schedule solved on them. The three lifecycle edges destroy
 * nothing: publishing opens a door, starting mints matches, ending archives. They are
 * consequential and one-way, which is what earns them a dialog — not destructive, which
 * is what would earn them the red.
 *
 * There is a second reason not to spend the red here. `variant="destructive"` fails AA
 * colour contrast (#1039, open), which is why `e2e/tournaments/` carries a
 * `KNOWN_DESTRUCTIVE_BUTTON_CONTRAST` axe exclusion wherever one is on screen. Painting
 * three more surfaces with it would widen a known defect to the lifecycle flows for
 * nothing the copy does not already say.
 */
export const ConfirmIrreversibleActDialog = ({
  open,
  consequence,
  onConfirm,
  onCancel,
}: ConfirmIrreversibleActDialogProps) => {
  // Radix closes the dialog itself on the ACTION click too, and reports it through
  // the same onOpenChange(false) as Escape — remember a confirm so its
  // close is not double-reported as a cancel (a confirm is not a cancel).
  const confirmed = useRef(false)

  const body = (() => {
    switch (consequence.variant) {
      case 'recut-draw':
        return {
          title: 'Re-cut this draw?',
          description: (
            <>
              Re-cutting <Strong>{consequence.eventName}</Strong> deals a completely
              new set of pairings. The pairings standing now are discarded, and so is
              any schedule built on them.
            </>
          ),
          confirmLabel: 'Re-cut the draw',
          confirmVariant: 'destructive' as const,
        }
      case 'delete-draw':
        return {
          title: 'Delete this draw?',
          description: (
            <>
              Deleting the draw for <Strong>{consequence.eventName}</Strong> removes
              its pairings and every fixture in it, the solved schedule included.
              Nothing is kept.
            </>
          ),
          confirmLabel: 'Delete the draw',
          confirmVariant: 'destructive' as const,
        }
      // The visibility boundary. A draft is the director's alone — a stranger's GET of
      // one is a 404 (#967) — and publishing is what puts it in front of everybody else.
      case 'publish-tournament':
        return {
          title: 'Publish this tournament?',
          description: (
            <>
              Publishing <Strong>{consequence.tournamentName}</Strong> takes it out of
              your drafts and puts it in front of everybody: players can find it and
              enter it from this moment on. There is no un-publishing it.
            </>
          ),
          confirmLabel: 'Publish',
          confirmVariant: 'default' as const,
        }
      // The costliest of the three, and the reason none of them is exempt: since #788
      // going live does not merely change a label, it MINTS the matches. The copy says
      // both halves, because both are spent on the players and neither comes back.
      case 'start-tournament':
        return {
          title: 'Start this tournament?',
          description: (
            <>
              Starting <Strong>{consequence.tournamentName}</Strong> closes
              registration for good — nobody can enter or withdraw afterwards — and
              turns every ready fixture into a match its players can go and play. It
              cannot be un-started.
            </>
          ),
          confirmLabel: 'Start the tournament',
          confirmVariant: 'default' as const,
        }
      // The one edge with nowhere to go afterwards.
      case 'end-tournament':
        return {
          title: 'End this tournament?',
          description: (
            <>
              Ending <Strong>{consequence.tournamentName}</Strong> archives it, and
              archived is the last thing a tournament is. There is no way back to live
              and no way to re-open it.
            </>
          ),
          confirmLabel: 'End the tournament',
          confirmVariant: 'default' as const,
        }
      default: {
        // A variant without copy of its own is a TYPE error here, not a dialog that
        // prices the wrong act.
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
        // Every OTHER close — Go back, Escape — reads as the
        // cancel: a stray dismiss must never destroy a draw. The flag is
        // consumed per close, so a dialog a parent keeps mounted stays honest.
        if (!confirmed.current) onCancel()
        confirmed.current = false
      }}
    >
      {/* No testid of its own: `role="alertdialog"` already names it, and the two
          buttons carry the only hooks a page object cannot get from a role. */}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{body.title}</AlertDialogTitle>
          <AlertDialogDescription>{body.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* No onClick of its own: the cancel is reported once, through
              onOpenChange, the same channel Escape uses. */}
          <AlertDialogCancel data-testid="confirm-irreversible-act-cancel">
            Go back
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="confirm-irreversible-act-confirm"
            // Decided by the act, in the same switch that wrote its sentence — see the
            // component doc: the red is for the two verbs that throw work away.
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
