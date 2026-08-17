import { Card } from '@/components/ui/card'

import type { UnscheduledFixture } from '../../data/timeline'

export interface UnscheduledRailProps {
  items: UnscheduledFixture[]
}

/**
 * The Gantt's side rail: the fixtures the board **cannot draw** — no table, or a
 * table with no time yet. Listed, never dropped: a board that only showed what
 * fits on the axis would read as a day with fewer matches than it has. Renders
 * nothing when everything is placed (absence of a rail is the good news).
 */
export const UnscheduledRail = ({ items }: UnscheduledRailProps) => {
  if (items.length === 0) return null
  return (
    <section
      data-testid="schedule-unscheduled"
      aria-label="Not yet scheduled"
      className="w-full shrink-0 lg:w-64"
    >
      <div className="mb-2 flex items-baseline gap-2">
        <h4 className="text-[13px] font-semibold text-[color:var(--fg-1)]">
          Not yet scheduled
        </h4>
        <span className="rounded-full bg-[color:var(--bg-raised)] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[color:var(--fg-2)]">
          {items.length}
        </span>
      </div>
      <Card className="gap-0 p-0">
        <ul>
          {items.map((item) => (
            <li
              key={item.fixtureId}
              data-testid={`unscheduled-${item.fixtureId}`}
              className="flex flex-col gap-0.5 border-t border-[color:var(--border-subtle)] px-3 py-2 text-[12px] first:border-t-0"
            >
              <span className="text-[color:var(--fg-1)]">{item.label}</span>
              <span className="text-[11px] text-[color:var(--fg-3)]">
                {item.eventName}
                {item.contextLabel ? ` · ${item.contextLabel}` : ''}
                {/* A half-placement: it has a table but no predicted time yet. */}
                {item.tableLabel ? ` · ${item.tableLabel}, no time yet` : ''}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  )
}
