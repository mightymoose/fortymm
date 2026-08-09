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

import type { OwnedStructureSetting } from '../data/draw-ownership'

/**
 * What confirming would SPEND — the dialog's whole content, as a sum type (no bag of
 * optional props): each variant carries exactly the context its copy names, so a draw
 * act cannot be rendered without the event whose pairings it discards, nor a lifecycle
 * act without the tournament it moves (ADR "a confirm prices an irreversible act, a
 * freeze explains an illegal one").
 *
 * Seven acts, of four kinds. The two **draw** acts discard a standing draw and the schedule
 * solved on it. The three **lifecycle** edges are the forward-only path a tournament walks
 * — `draft → published → live → archived` — with no edge back and `archived` terminal, so
 * every one of them is one-way too. The one **pool-count** act discards reservations: a
 * lowered pool count on the Draw structure tab removes pool rows, and a removed row takes
 * its time window and its table selections with it (ADR 20260808 — "lowering a manual pool
 * count removes rows, which is destructive"). The one **draw-structure** act discards
 * ownership: leaving `rr-then-ko` leaves the pool stage those settings shape, so the
 * settings the director took go back to the system (the same ADR).
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

/** The acts that belong to a **tournament's lifecycle** — the mirror of
 * `DrawActConsequence`, and narrow for the same reason: `LifecycleActions` owns exactly
 * these three, so its state must be unable to hold a draw act it has no way to perform.
 * The two aliases are what keep the wide union out of both components; nothing but the
 * dialog itself is typed on `IrreversibleActConsequence`. */
export type LifecycleActConsequence =
  | { variant: 'publish-tournament'; tournamentName: string }
  | { variant: 'start-tournament'; tournamentName: string }
  | { variant: 'end-tournament'; tournamentName: string }

/** The act that belongs to the Draw structure tab's **pool count** — narrow for the third
 * time, and for the same reason: the tab can price exactly this one, so its state must be
 * unable to hold a draw verb or a lifecycle edge it has no way to perform.
 *
 * It carries the pool **names**, not a count, because the copy names them: a director
 * about to lose `Pool E` and `Pool F` needs to know which two reservations go, and a bare
 * "2 pools" would make them count the cards on the other tab to find out. */
export type PoolCountActConsequence = {
  variant: 'remove-pool-reservations'
  eventName: string
  /** The pools that would go, in the order the Table pools tab lists them. Never empty:
   * a reconciliation that removes nothing is not an act worth pricing, and the tab does
   * not open the dialog for one. */
  poolNames: string[]
}

/** The act that belongs to the Basics tab's **draw type** — narrow for the fourth time,
 * and for the same reason as the three above.
 *
 * Only a `rr-then-ko` draw has a pool stage feeding a knockout, so leaving that draw type
 * leaves the settings behind (ADR 20260808 — "switching away from `rr-then-ko` can discard
 * a director's work"). The dialog is opened **only** when something is actually the
 * director's: an all-automatic event loses nothing, and a confirm that priced nothing would
 * be the ceremony ADR 20260806 refuses. */
export type DrawStructureActConsequence = {
  variant: 'discard-draw-structure'
  eventName: string
  /** The settings the director owns, read back with the values they set. **Never empty** —
   * see above. Carried as label/value pairs rather than as a pre-joined sentence, so the
   * copy that reads them out lives here with the rest of the dialog's words. */
  settings: OwnedStructureSetting[]
  /** How many pool rows the event has. The switch does **not** touch them, and the copy
   * says so — a pool restricts scheduling whatever the draw type (ADR 20260807), so the
   * tables and windows a director booked survive a change of format. Zero is a real
   * answer, and the sentence is dropped for it rather than reading `0 pools`. */
  poolReservationCount: number
}

export type IrreversibleActConsequence =
  | DrawActConsequence
  | LifecycleActConsequence
  | PoolCountActConsequence
  | DrawStructureActConsequence

export interface ConfirmIrreversibleActDialogProps {
  open: boolean
  consequence: IrreversibleActConsequence
  onConfirm: () => void
  onCancel: () => void
}

const Strong = ({ children }: { children: React.ReactNode }) => (
  <span className="font-semibold text-[color:var(--fg-1)]">{children}</span>
)

/** What a pool with an emptied name box is called in this sentence. Reachable: the name is
 * the one thing on a pool card a director can *clear*, and the save is refused for it
 * later (`poolNameIssues`) — but the confirm comes first, and "removes  and Pool F" names
 * nothing. */
const UNNAMED_POOL = 'an unnamed pool'

/** How many pools the sentence names before it starts counting them. Three is enough for
 * the ordinary case (a director nudging six pools down to four) and the cap is what keeps
 * a drop from 512 to 1 from reading out 511 names. */
const MAX_NAMED_POOLS = 3

/** `A`, `A and B`, `A, B and C` — the one place this dialog turns a list into a phrase,
 * so its two list-reading variants cannot punctuate differently. */
const andList = (parts: string[]): string => {
  if (parts.length < 2) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** `Pool E`, `Pool E and Pool F`, `Pool D, Pool E and Pool F`, and past the cap
 * `Pool D, Pool E, Pool F and 8 more`. */
const removedPoolList = (names: string[]): string => {
  const shown = names
    .slice(0, MAX_NAMED_POOLS)
    .map((name) => name.trim() || UNNAMED_POOL)
  const unshown = names.length - shown.length
  return andList(unshown > 0 ? [...shown, `${unshown} more`] : shown)
}

/** `Pool count (6), Pool size (5) and Membership (Assign at cut time)` — every setting
 * read back with the value the director set, because "your draw structure settings" names
 * nothing a director can check against what they typed. **No cap**, unlike the pool list:
 * there are four settings in all, so the longest this can run is four. */
const ownedSettingList = (settings: OwnedStructureSetting[]): string =>
  andList(settings.map((setting) => `${setting.label} (${setting.value})`))

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
 * ## Why only four of the seven wear the destructive treatment
 *
 * The confirm's `variant` is decided by the same `switch` that writes the copy, so a new
 * variant cannot acquire a sentence without also answering for how its button looks.
 * `destructive` is reserved for the acts that **throw work away** — the two draw verbs
 * discard pairings and the schedule solved on them, a lowered pool count discards
 * reservations with their windows and their tables, and a changed draw type discards the
 * structural settings a director typed. The three lifecycle edges destroy
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
          // Verb plus object, like every other act's button — and never the bare
          // `Publish` the HEADER button says. Two controls with one accessible name put
          // the dialog's button and the header's in the same role query, so an assertion
          // that meant one could resolve to the other and pass while checking nothing.
          confirmLabel: 'Publish the tournament',
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
      // The pool count is the pool ROWS (ADR 20260808), so lowering it removes rows — and
      // a row is a reservation, with a window and a set of tables somebody chose. The
      // sentence names which pools go, because that is the part the director cannot work
      // out from the number they just typed.
      //
      // It deliberately does NOT say "there is no undoing this": the removal lands in the
      // editor's draft, and closing the sheet without saving really does put the pools
      // back. What does not come back is the work — raising the count again mints blank
      // rows with no tables — so the copy prices the work and claims nothing more.
      case 'remove-pool-reservations': {
        const count = consequence.poolNames.length
        return {
          title: `Remove ${count} pool ${count === 1 ? 'reservation' : 'reservations'}?`,
          description: (
            <>
              Lowering the pool count for <Strong>{consequence.eventName}</Strong>{' '}
              removes <Strong>{removedPoolList(consequence.poolNames)}</Strong>.
              Each one takes its time window and its reserved tables with it.
            </>
          ),
          confirmLabel: count === 1 ? 'Remove the pool' : `Remove ${count} pools`,
          // Red, by the rule above: this throws away work a director did on another tab.
          confirmVariant: 'destructive' as const,
        }
      }
      // Leaving `rr-then-ko` leaves the pool stage, and the settings that shape it go with
      // it (ADR 20260808). The sentence names them with their values, because "your draw
      // structure settings" is the generic warning a confirm is supposed to replace.
      //
      // It says the settings go back to **automatic**, not that their numbers are deleted,
      // and that is the honest verb for what happens: the ownership record is dropped, and
      // the app derives every number again. The qualifier count keeps its stored value —
      // K is required on a two-stage event, and clearing it would refuse the next save.
      //
      // `We work them out again` rather than `from the field`, because membership is one of
      // the four and the snake is not derived from a field size — it deals entrants. One
      // sentence has to be true of all four settings the list can hold.
      //
      // And it says the **pools stay**, because a pool is a venue reservation as much as a
      // group, and a pool restricts scheduling whatever the draw type (ADR 20260807). The
      // director booked those tables and windows deliberately, so a change of format is not
      // a reason to hand them back.
      case 'discard-draw-structure': {
        const count = consequence.settings.length
        const pools = consequence.poolReservationCount
        return {
          title:
            count === 1
              ? 'Discard this draw structure setting?'
              : 'Discard these draw structure settings?',
          description: (
            <>
              Only a round-robin-then-knockout draw has a pool stage, so changing the
              draw type for <Strong>{consequence.eventName}</Strong> hands{' '}
              <Strong>{ownedSettingList(consequence.settings)}</Strong> back to
              automatic. We work them out again.
              {pools > 0 && (
                <>
                  {' '}
                  {pools === 1
                    ? 'The pool you booked stays exactly as it is.'
                    : `The ${pools} pools you booked stay exactly as they are.`}
                </>
              )}
            </>
          ),
          confirmLabel: 'Change the draw type',
          // Red, by the rule in the component doc: a setting the director typed is work,
          // and this throws it away.
          confirmVariant: 'destructive' as const,
        }
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
