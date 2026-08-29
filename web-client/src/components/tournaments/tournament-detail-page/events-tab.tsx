import { Plus, Trophy } from 'lucide-react'

import { useSession } from '@/api/session'
import { Button } from '@/components/ui/button'

import type { Tournament, TournamentEvent } from '../data/types'
import { EmptyState } from '../empty-state'
import { SectionHeader } from './section-header'
import { DrawPanel } from './events-tab/draw-panel'
import { EventCard } from './events-tab/event-card'
import { EnterEventControl } from './events-tab/enter-event-control'

export interface EventsTabProps {
  tournament: Tournament
  /** When false (a non-creator), the "New event" affordances are hidden and
   * the tab is a read-only list of events. */
  canEdit: boolean
  onOpenEvent: (event: TournamentEvent) => void
  onNewEvent: () => void
}

/** The Events tab: a list of event row-cards with a "New event" action and an
 * empty state. */
export const EventsTab = ({
  tournament,
  canEdit,
  onOpenEvent,
  onNewEvent,
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
  const username = useSession().data?.data.user.username

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
              action={<EnterEventControl tournament={tournament} event={ev} />}
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
    </div>
  )
}
