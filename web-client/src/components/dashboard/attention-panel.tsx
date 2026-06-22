import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { UserAvatar } from '@/components/ui/user-avatar'
import {
  isAttentionPanelEmpty,
  type AttentionPanelView,
} from './attention-panel-view'

export interface AttentionPanelProps {
  view: AttentionPanelView
}

/**
 * The dashboard's "Needs your attention" triage panel: up to three
 * priority-ordered, action-only rows (avatar · `vs @opponent` · one button)
 * plus a footer summarizing overflow + waiting counts and a `View all` link.
 * Pure view-in — all ranking/labels/routing are decided by
 * `projectAttentionPanelView`. Buttons only route; they never finalize a
 * result. Hides entirely when there are no actionable rows — it's purely a
 * to-do list, so a user with nothing to do sees no panel at all.
 */
export const AttentionPanel = ({ view }: AttentionPanelProps) => {
  const { rows, overflowCount, waitingCount, viewAllSearch } = view
  if (isAttentionPanelEmpty(view)) return null
  return (
    <section
      aria-labelledby="needs-attention-heading"
      className="mb-8"
      data-testid="dashboard-attention-panel"
    >
      <Card className="flex flex-col gap-0 p-0">
        <h2
          id="needs-attention-heading"
          className="px-5 pt-4 pb-3 text-[18px] font-semibold tracking-tight text-[color:var(--chalk-50)]"
        >
          Needs your attention
        </h2>
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.matchId}
              className="flex items-center gap-3 border-t border-[color:var(--ink-700)] px-5 py-3"
            >
              <UserAvatar name={row.opponentName} size={40} />
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[color:var(--chalk-50)]">
                {row.headline}
              </span>
              <Button
                asChild
                variant={row.primary ? 'default' : 'outline'}
                size="sm"
              >
                <Link {...row.route}>
                  {row.actionLabel}
                  <ArrowRight size={14} strokeWidth={1.75} />
                </Link>
              </Button>
            </li>
          ))}
        </ul>
        <AttentionFooter
          overflowCount={overflowCount}
          waitingCount={waitingCount}
          viewAllSearch={viewAllSearch}
        />
      </Card>
    </section>
  )
}

function AttentionFooter({
  overflowCount,
  waitingCount,
  viewAllSearch,
}: {
  overflowCount: number
  waitingCount: number
  viewAllSearch: { status: 'attention' }
}) {
  const parts: string[] = []
  if (overflowCount > 0) {
    parts.push(
      `${overflowCount} more ${overflowCount === 1 ? 'needs' : 'need'} attention`,
    )
  }
  if (waitingCount > 0) parts.push(`${waitingCount} waiting on others`)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[color:var(--ink-700)] px-5 py-3 text-[13px] text-[color:var(--chalk-500)]">
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 && <span aria-hidden="true">·&nbsp;</span>}
          {part}
        </span>
      ))}
      <Link
        to="/matches"
        search={viewAllSearch}
        className="font-medium text-[color:var(--chalk-300)] hover:text-[color:var(--chalk-50)]"
      >
        View all
      </Link>
    </div>
  )
}
