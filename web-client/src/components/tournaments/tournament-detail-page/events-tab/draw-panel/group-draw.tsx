import { useId } from 'react'

import { Badge } from '@/components/ui/badge'

import type { GroupDraw as GroupDrawView } from '../../../data/draw'
import { RoundList } from './round-list'

export interface GroupDrawProps {
  group: GroupDrawView
}

/**
 * One **group** of a cut draw: its position-derived label (`Group A`, `Group B`, … — a
 * group carries no stored name of its own, ticket #1369), the entrants the draw dealt
 * into it, and its fixtures round by round.
 *
 * The entrants are the group's *membership*, and nothing stores it — it is derived from
 * the group's own fixtures (ADR-0786, the same argument as ADR-0016's derived `entered`
 * count), in **draw order** (seed, then registration). They are listed as chips, in the
 * roster's voice, because "who is in this group" is the first question a director asks
 * of a draw and the fixtures alone answer it only by cross-referencing.
 *
 * A group with an odd number of entrants simply has rounds with fewer fixtures in them —
 * see `RoundList`. There is no bye row, here or anywhere.
 *
 * Inert: a fixture is a *planned* pairing, not a match (CONTEXT.md), so there is nothing
 * to click on it until it materializes into one (#788).
 */
export const GroupDraw = ({ group }: GroupDrawProps) => {
  const headingId = useId()

  return (
    <section
      data-testid={`group-draw-${group.id}`}
      aria-labelledby={headingId}
      className="rounded-[10px] border border-[color:var(--border-subtle)] p-3"
    >
      <h4
        id={headingId}
        className="text-[13px] font-semibold text-[color:var(--fg-1)]"
      >
        {group.label}
      </h4>

      {/* Named per group: a draw holds several rosters, and a screen reader running the
          list rotor needs to tell one group's entrants from the next's. */}
      <ul
        aria-label={`Entrants in ${group.label}`}
        className="mt-1.5 flex flex-wrap items-center gap-1.5"
      >
        {group.entrants.map((entrant) => (
          <Badge
            key={entrant.id}
            asChild
            variant="ghost"
            className="border-[color:var(--border-subtle)]"
          >
            {/* Rendered as the <li> itself (`asChild`), so the list stays a list: <ul>
                may only parent <li>. */}
            <li>{entrant.username}</li>
          </Badge>
        ))}
      </ul>

      <RoundList rounds={group.rounds} groupName={group.label} />
    </section>
  )
}
