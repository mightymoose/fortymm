import { Plus, Trophy } from 'lucide-react'
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from 'react'

import { useSession } from '@/api/session'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import type { Tournament, TournamentEvent } from '../data/types'
import type { TournamentCheckout } from '../data/api'
import {
  refusedCheckoutEventId,
  useCancelCheckout,
  useCurrentCheckout,
  useRefreshTournamentCheckout,
  useStartCheckout,
} from '../data/api'
import { useCheckoutById } from '../data/payments'
import { EmptyState } from '../empty-state'
import { SectionHeader } from './section-header'
import { DrawPanel } from './events-tab/draw-panel'
import { EventCard } from './events-tab/event-card'
import { EnterEventControl } from './events-tab/enter-event-control'
import { CheckoutSummary } from './events-tab/checkout-summary'
import { CheckoutPanel } from './events-tab/checkout-panel'
import { YourReceipts } from './events-tab/your-receipts'
import {
  isCheckoutEventEligible,
  MAX_CHECKOUT_EVENTS,
  toggleCheckoutEvent,
} from './events-tab/checkout-policy'

export interface EventsTabProps {
  tournament: Tournament
  /** When false (a non-creator), the "New event" affordances are hidden and
   * the tab is a read-only list of events. */
  canEdit: boolean
  onOpenEvent: (event: TournamentEvent) => void
  onNewEvent: () => void
  checkoutDraftIds?: Set<string>
  onCheckoutDraftChange?: Dispatch<SetStateAction<Set<string>>>
  /** `?checkout=`: the checkout the panel shows after a reload or a 3-D Secure
   * return, whatever its status (#1809). */
  checkoutParam?: string
  onCheckoutParamChange?: (checkoutId: string | undefined) => void
  /** Open the receipt page of a succeeded payment (#1810). */
  onViewReceipt?: (paymentId: string) => void
}
/** The Events tab: a list of event row-cards with a "New event" action and an
 * empty state. */
export const EventsTab = ({
  tournament,
  canEdit,
  onOpenEvent,
  onNewEvent,
  checkoutDraftIds,
  onCheckoutDraftChange,
  checkoutParam,
  onCheckoutParamChange,
  onViewReceipt,
}: EventsTabProps) => {
  // The draw formats the server offers (ADR 20260726), handed to each card so it can
  // name the event's draw type in the server's words. Read off the tournament rather
  // than taken as a prop of its own: a second prop carrying the same fact is a pair
  // that can disagree, and only one of them is the payload. `null` means the catalogue
  // never arrived (the list route withholds it), which a card renders as "no words for
  // this slug" — never the raw slug.
  const drawTypes = tournament.drawTypes ?? []
  // Who the viewer is, read once for the whole tab and handed to every card: the
  // roster needs it to pin the player's own chip into a truncated list (#781),
  // and "which entrant is me" is a join on the USERNAME — the session carries no
  // user id (see `myEntrant`). `EnterEventControl` reads the same session for the
  // same join, so the chip and the Enter/Withdraw control can never disagree.
  const session = useSession()
  const username = session.data?.data.user.username
  const [localSelectedIds, setLocalSelectedIds] = useState<Set<string>>(() => new Set())
  const selectedIds = checkoutDraftIds ?? localSelectedIds
  const setSelectedIds = onCheckoutDraftChange ?? setLocalSelectedIds
  const checkoutDiscoveryEnabled =
    tournament.checkoutAvailable &&
    tournament.status === 'published' &&
    tournament.registrationOpen !== false
  const currentCheckout = useCurrentCheckout(
    tournament.id,
    session.isSuccess,
    checkoutDiscoveryEnabled,
  )
  const startCheckout = useStartCheckout(tournament.id)
  const cancelCheckout = useCancelCheckout(tournament.id)
  const refreshCheckout = useRefreshTournamentCheckout(tournament.id)
  const checkout = currentCheckout.data?.status === 'active' ? currentCheckout.data : null
  const activeCheckoutId = checkout?.id
  // The checkout the panel shows. Once the panel opens it stays pinned until the
  // player leaves it, so a hold that ends or a payment that completes stays on
  // screen instead of vanishing with the "current checkout" read.
  const [pinnedCheckoutId, setPinnedCheckoutId] = useState<string | undefined>()
  // Checkouts the player has left with "Done" or "Back to events". A payment
  // under review leaves its checkout active, and the panel must not pin it
  // straight back.
  const [dismissedCheckoutIds, setDismissedCheckoutIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const liveCheckoutId =
    activeCheckoutId && !dismissedCheckoutIds.has(activeCheckoutId)
      ? activeCheckoutId
      : undefined
  if (liveCheckoutId && liveCheckoutId !== pinnedCheckoutId) {
    // Adjusting state to a new active checkout during render, React's pattern
    // for deriving state from changed input without an extra effect pass.
    setPinnedCheckoutId(liveCheckoutId)
  }
  const panelCheckoutId = checkoutParam ?? pinnedCheckoutId ?? liveCheckoutId
  const checkoutById = useCheckoutById(
    tournament.id,
    panelCheckoutId !== undefined && panelCheckoutId !== activeCheckoutId
      ? panelCheckoutId
      : undefined,
  )
  // Name the shown checkout in `?checkout=`, so a reload lands on it and the
  // open-checkout bar leaves out exactly this one (#1809).
  useEffect(() => {
    if (panelCheckoutId && panelCheckoutId !== checkoutParam) {
      onCheckoutParamChange?.(panelCheckoutId)
    }
  }, [panelCheckoutId, checkoutParam, onCheckoutParamChange])
  const [releaseFailed, setReleaseFailed] = useState(false)
  /** Leave the panel. `reselect` ticks those events again on the list. */
  const closePanel = (reselect?: string[]) => {
    setReleaseFailed(false)
    if (panelCheckoutId) {
      setDismissedCheckoutIds((current) => new Set(current).add(panelCheckoutId))
    }
    setPinnedCheckoutId(undefined)
    onCheckoutParamChange?.(undefined)
    if (reselect) setSelectedIds(new Set(reselect))
  }
  // The last copy of the panel's checkout this tab saw. When the "current"
  // read drops a hold, the by-id read takes over; until it lands, the panel
  // keeps this copy instead of flashing a loading state.
  const [lastPanelCheckout, setLastPanelCheckout] = useState<TournamentCheckout | null>(null)
  const freshPanelCheckout =
    panelCheckoutId === undefined
      ? null
      : panelCheckoutId === activeCheckoutId
        ? checkout
        : (checkoutById.data ?? null)
  if (freshPanelCheckout && freshPanelCheckout !== lastPanelCheckout) {
    setLastPanelCheckout(freshPanelCheckout)
  }
  const panelCheckout =
    freshPanelCheckout ??
    (lastPanelCheckout?.id === panelCheckoutId ? lastPanelCheckout : null)
  // The POST response can be lost after the server commits. The mutation's
  // reconciliation then discovers the durable checkout; adopt that server state
  // and discard the draft after commit so a controlled draft does not update its
  // parent while this child is rendering.
  useEffect(() => {
    if (activeCheckoutId && selectedIds.size > 0) {
      setSelectedIds(new Set())
    }
  }, [activeCheckoutId, selectedIds, setSelectedIds])
  const hidePaidSelection = panelCheckoutId !== undefined || startCheckout.isPending
  const disablePaidSelection = currentCheckout.isFetching
  const selectedEvents = useMemo(
    () =>
      tournament.events.filter(
        (event) =>
          selectedIds.has(event.id) &&
          isCheckoutEventEligible(tournament, event, username),
      ),
    [selectedIds, tournament, username],
  )
  const effectiveSelectedIds = useMemo(
    () => new Set(selectedEvents.map((event) => event.id)),
    [selectedEvents],
  )
  useEffect(() => {
    if (!activeCheckoutId && effectiveSelectedIds.size !== selectedIds.size) {
      // Editing or externally updating an event can make a draft impossible to
      // submit. Prune it after commit; controlled state belongs to the parent.
      setSelectedIds(effectiveSelectedIds)
    }
  }, [activeCheckoutId, effectiveSelectedIds, selectedIds, setSelectedIds])
  // The event the server refused when checkout started. The player stays on
  // the list with the selection intact until they remove it (#1809).
  const [refusedEventId, setRefusedEventId] = useState<string | null>(null)
  const refusedEvent = selectedEvents.find((event) => event.id === refusedEventId)
  const togglePaid = (eventId: string) => {
    if (hidePaidSelection || disablePaidSelection) return
    setSelectedIds((current) => toggleCheckoutEvent(current, eventId))
  }

  return (
    <div>
      <SectionHeader
        title="Events"
        // A card opens the editor for the organizer and a read-only view for
        // everyone else, so the invitation to click says what clicking will
        // actually get you (ADR 0015, rule 5).
        subtitle={
          canEdit
            ? 'Singles, doubles, rating-restricted brackets. Click any event to edit.'
            : 'Singles, doubles, rating-restricted brackets. Click any event for details.'
        }
        action={
          canEdit && (
            <Button onClick={onNewEvent}>
              <Plus size={16} />
              New event
            </Button>
          )
        }
      />
      <YourReceipts tournamentId={tournament.id} onViewReceipt={onViewReceipt} />
      {panelCheckoutId !== undefined ? (
        panelCheckout ? (
          <CheckoutPanel
            checkout={panelCheckout}
            onExpired={() => {
              refreshCheckout()
              void checkoutById.refetch()
            }}
            onConfirmStarted={() => onCheckoutParamChange?.(panelCheckout.id)}
            pending={cancelCheckout.isPending}
            releaseFailed={releaseFailed}
            resumed={checkoutParam === panelCheckout.id}
            onDone={() => closePanel()}
            onViewReceipt={onViewReceipt}
            onCancel={() => {
              void cancelCheckout
                .mutateAsync(panelCheckout.id)
                .then(() => closePanel())
                .catch(() => undefined)
            }}
            onChangeSelection={() => {
              const previous = panelCheckout.lines.map((line) => line.eventId)
              void cancelCheckout
                .mutateAsync(panelCheckout.id)
                .catch(() => undefined)
                .then(async () => {
                  // A DELETE response can be lost after the server commits.
                  // Restore the editable selection from durable reconciled
                  // state, not only from the mutation's success callback.
                  const reconciled = await currentCheckout.refetch()
                  if (reconciled.data === null) closePanel(previous)
                })
            }}
            onReviewAvailability={() => {
              const previous = panelCheckout.lines.map((line) => line.eventId)
              // Cancel first: an ended hold can still have an open payment,
              // and a late success must refund rather than admit alongside a
              // replacement checkout. The server treats this as a no-op when
              // nothing is open.
              setReleaseFailed(false)
              void cancelCheckout.mutateAsync(panelCheckout.id).then(
                () => {
                  closePanel(previous)
                  // Fresh prices and availability for the re-ticked events.
                  refreshCheckout()
                },
                // Stay put: the old payment may still be confirmable, and a
                // replacement checkout could charge the player twice.
                () => setReleaseFailed(true),
              )
            }}
          />
        ) : checkoutById.isError ? (
          <Alert variant="destructive" className="mb-5">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>We couldn’t find that checkout.</span>
              <Button variant="outline" size="sm" onClick={() => closePanel()}>
                Back to events
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <p role="status" className="py-8 text-center text-muted-foreground">
            Loading your checkout…
          </p>
        )
      ) : (
        <>
      <CheckoutSummary
        selection={selectedEvents}
        pending={currentCheckout.isFetching || startCheckout.isPending}
        onCheckout={() => {
          setRefusedEventId(null)
          startCheckout.mutate(selectedEvents.map((event) => event.id), {
            onSuccess: () => setSelectedIds(new Set()),
            onError: (error) => setRefusedEventId(refusedCheckoutEventId(error)),
          })
        }}
        onRemoveSelection={(eventId) => togglePaid(eventId)}
      />
      {refusedEvent && (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{refusedEvent.name} is no longer available.</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                togglePaid(refusedEvent.id)
                setRefusedEventId(null)
              }}
            >
              Remove {refusedEvent.name}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {tournament.events.length === 0 ? (
        <EmptyState
          icon={<Trophy size={28} />}
          title="No events yet"
          hint="Add your first event — Open Singles, U1500, Women's, etc."
          action={
            canEdit && (
              <Button onClick={onNewEvent}>
                <Plus size={16} />
                Add an event
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {tournament.events.map((ev) => (
            <EventCard
              key={ev.id}
              event={ev}
              canEdit={canEdit}
              drawTypes={drawTypes}
              username={username}
              onOpen={() => onOpenEvent(ev)}
              // Self-registration is a *player's* affordance, not the owner's:
              // it is gated on nothing but the event itself (entering needs no
              // permission, #1092), never on `canEdit`. The control
              // decides for itself whether it applies (session loaded, singles)
              // and renders nothing when it doesn't — and it takes the whole
              // tournament, not just its id, because whether registration is open
              // at all is a property of the tournament's STATUS (ADR-0017).
              action={
                <EnterEventControl
                  tournament={tournament}
                  event={ev}
                  selected={effectiveSelectedIds.has(ev.id)}
                  onTogglePaid={() => togglePaid(ev.id)}
                  paidSelectionLocked={
                    hidePaidSelection ||
                    (effectiveSelectedIds.size >= MAX_CHECKOUT_EVENTS &&
                      !effectiveSelectedIds.has(ev.id))
                  }
                  paidSelectionDisabled={disablePaidSelection}
                />
              }
              // The event's draw (ADR-0786): its groups and fixtures for everyone, its
              // three verbs for the director alone. It hangs off the EVENT, not off a
              // tab of its own — a draw belongs to one event, and a "Draw" tab would
              // have to ask which one it meant. `canEdit` is the tournament's, the same
              // flag every other owner-only affordance on this page is gated on.
              draw={
                <DrawPanel
                  tournamentId={tournament.id}
                  event={ev}
                  canEdit={canEdit}
                />
              }
            />
          ))}
        </div>
      )}
        </>
      )}
    </div>
  )
}
