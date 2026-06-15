import { Link } from '@tanstack/react-router'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Overline } from '@/components/overline'
import { fmtLongDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

import type { DashboardHeaderView } from './dashboard-header/dashboard-header-view'

export interface DashboardHeaderProps {
  view: DashboardHeaderView
  /**
   * Below the compact breakpoint the action button drops to its own full-width
   * line and the headline shrinks. Layout-only, owned by the host (it derives
   * from the viewport, not the dashboard payload).
   */
  compact: boolean
}

/**
 * The dashboard page header: a date overline, the personalized greeting, and
 * the "Log a match" action. Pure view-in — the greeting text is derived by
 * `projectDashboardHeaderView`; `compact` only drives layout.
 */
export const DashboardHeader = ({ view, compact }: DashboardHeaderProps) => {
  return (
    <div
      className={cn(
        'mb-6 flex gap-4',
        compact ? 'flex-col items-stretch' : 'flex-row items-end',
      )}
    >
      <div>
        <Overline className="mb-2">Dashboard · {fmtLongDate()}</Overline>
        <h1
          style={{
            margin: 0,
            font: `700 ${compact ? 26 : 32}px var(--font-ui)`,
            letterSpacing: '-0.015em',
            color: 'var(--chalk-50)',
            lineHeight: 1.05,
          }}
        >
          {view.greeting}
          <span style={{ color: 'var(--ball-500)' }}>.</span>
        </h1>
      </div>
      {!compact && <div className="flex-1" />}
      <Button asChild variant="outline" className={cn(compact && 'w-full')}>
        <Link to="/matches/new">
          <Plus size={16} strokeWidth={1.75} />
          Log a match
        </Link>
      </Button>
    </div>
  )
}
