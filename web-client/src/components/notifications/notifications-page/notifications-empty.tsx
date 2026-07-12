import { Link } from '@tanstack/react-router'
import { Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Which empty the inbox is. The two cases are mutually exclusive and want
 * *different* next actions, so they're a sum type rather than a pair of
 * booleans: telling someone whose Unread filter is clear to "go play" would be
 * wrong — they have notifications, just none under this filter (#901).
 *
 * `onShowAll` rides on the `filter-empty` arm because an empty inbox has no
 * filter to clear — the type carries the invariant, so no call site can pass a
 * filter-clearing callback that nothing can reach.
 */
export type NotificationsEmptyState =
  | { kind: 'inbox-empty' }
  | { kind: 'filter-empty'; filterLabel: string; onShowAll: () => void }

export interface NotificationsEmptyProps {
  state: NotificationsEmptyState
}

/** The notifications list's empty state: a headline that tells the truth about
 * which empty it is, and a next action that fits it.
 *
 * Only an empty *inbox* is "All caught up." A filter that matches nothing must
 * not borrow that reassurance — the user's notifications are still sitting
 * there, one pill away, and QA rightly read the pair as contradicting itself. */
export function NotificationsEmpty({ state }: NotificationsEmptyProps) {
  return (
    <div className="px-5 py-14 text-center">
      <span className="mb-3.5 inline-flex size-14 items-center justify-center rounded-full bg-[color:var(--bg-card)] text-[color:var(--fg-muted)]">
        <Inbox size={26} />
      </span>
      <p className="text-base font-semibold text-[color:var(--fg-2)]">
        {state.kind === 'inbox-empty'
          ? 'All caught up.'
          : `Nothing under ${state.filterLabel}.`}
      </p>
      <p className="mt-1 text-[13px] text-[color:var(--fg-3)]">
        {state.kind === 'inbox-empty'
          ? 'Nothing here. Go play.'
          : 'Your other notifications are still in the inbox.'}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        {state.kind === 'inbox-empty' ? (
          <>
            <Button asChild size="sm">
              <Link to="/matches/new">Log a match</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/notifications/settings">Notification preferences</Link>
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={state.onShowAll}
          >
            Show all notifications
          </Button>
        )}
      </div>
    </div>
  )
}
