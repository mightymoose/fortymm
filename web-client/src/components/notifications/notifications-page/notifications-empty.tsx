import { Link } from '@tanstack/react-router'
import { Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Which empty the inbox is. The two cases are mutually exclusive and want
 * *different* next actions, so they're a sum type rather than a pair of
 * booleans: telling someone whose Unread filter is clear to "go play" would be
 * wrong — they have notifications, just none under this filter (#901).
 */
export type NotificationsEmptyState =
  | { kind: 'inbox-empty' }
  | { kind: 'filter-empty'; filterLabel: string }

export interface NotificationsEmptyProps {
  state: NotificationsEmptyState
  /** Clears the active filter. Only reachable from the `filter-empty` state. */
  onShowAll: () => void
}

/** The notifications list's empty state: the same reassurance either way, but a
 * next action that fits which empty it is. */
export function NotificationsEmpty({ state, onShowAll }: NotificationsEmptyProps) {
  return (
    <div className="px-5 py-14 text-center">
      <span className="mb-3.5 inline-flex size-14 items-center justify-center rounded-full bg-[color:var(--bg-card)] text-[color:var(--fg-muted)]">
        <Inbox size={26} />
      </span>
      <p className="text-base font-semibold text-[color:var(--fg-2)]">
        All caught up.
      </p>

      {state.kind === 'inbox-empty' ? (
        <>
          <p className="mt-1 text-[13px] text-[color:var(--fg-3)]">
            Nothing here. Go play.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
            <Button asChild size="sm">
              <Link to="/matches/new">Log a match</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/notifications/settings">Notification preferences</Link>
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-[color:var(--fg-3)]">
            Nothing under {state.filterLabel}.
          </p>
          <div className="mt-5 flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={onShowAll}>
              Show all notifications
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
