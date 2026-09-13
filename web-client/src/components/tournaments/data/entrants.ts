import type { Entrant, TournamentEvent } from './types'

/** Entries available to historical draws, schedules and results, including hidden players. */
export function historicalEntrants(event: TournamentEvent): Entrant[] {
  return [...event.entrants, ...event.retainedEntrants]
}
