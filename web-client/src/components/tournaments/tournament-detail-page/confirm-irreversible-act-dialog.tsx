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
 * act cannot be rendered without the event whose pairings it discards (ADR
 * "a confirm prices an irreversible act, a freeze explains an illegal one").
 *
 * The union is deliberately open: the three lifecycle edges (publish / start / end) are
 * the same kind of one-way act and join it later. The `never` default in the body switch
 * is what keeps that honest — a variant added here is a **type error** until it has copy
 * of its own, rather than a dialog that silently renders another act's sentence.
 *
 * Note what is NOT shared across the variants: there is no top-level `eventName` prop.
 * A lifecycle act is about a *tournament*, not an event, so hoisting the name would
 * oblige every future variant to supply a field its copy never says.
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
 * The consequence-stating confirm on an act a director **cannot undo**. Today the two
 * draw acts: re-cutting a standing draw, and deleting one. The first cut is exempt by
 * design — it is constructive and re-cuttable, and a confirm there would only train the
 * director to click through the ones that matter.
 *
 * The body names what the click *discards*, in the director's own terms, and names the
 * **event** with it: the Events tab renders one card per event, so "the draw" alone is
 * ambiguous the moment a tournament has more than one.
 *
 * The confirm button carries the act's own verb — `Re-cut the draw` / `Delete the draw` —
 * never a bare "OK" or "Confirm". Cancel is a no-op, and so is Escape — nothing fires.
 *
 * A click on the **overlay does nothing at all**: Radix's `AlertDialogContent`
 * `preventDefault`s both `onPointerDownOutside` and `onInteractOutside`, so the dialog
 * neither closes nor reports a cancel. That is the behaviour a destructive confirm wants —
 * a mis-click beside "Delete this draw?" must not dismiss it — so do not "restore" an
 * outside-click dismissal here. It is a property of `AlertDialog`, and it is the reason to
 * use `AlertDialog` rather than `Dialog` for a decision.
 *
 * Focus is trapped, and Radix's own `onOpenAutoFocus` lands it on **Go back** — the safe
 * default when the other button destroys something.
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
            variant="destructive"
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
