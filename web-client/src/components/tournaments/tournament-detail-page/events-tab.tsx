import { Plus, Trophy } from 'lucide-react'

import { Button } from '@/components/ui/button'

import type { Tournament, TournamentEvent } from '../data/types'
import { EmptyState } from '../empty-state'
import { SectionHeader } from './section-header'
import { EventCard } from './events-tab/event-card'

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
  return (
    <div>
      <SectionHeader
        title="Events"
        subtitle="Singles, doubles, age- and rating-restricted brackets. Click any event to edit."
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
            <EventCard key={ev.id} event={ev} onOpen={() => onOpenEvent(ev)} />
          ))}
        </div>
      )}
    </div>
  )
}
