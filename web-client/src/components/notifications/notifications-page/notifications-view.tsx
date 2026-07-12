import type {
  NotificationItem,
  NotificationTaxonomy,
} from '@/api/notifications'
import { cn } from '@/lib/utils'
import type { NotificationCategory } from '../notification-meta'
import { NotificationRow } from '../notification-row'
import {
  NotificationsEmpty,
  type NotificationsEmptyState,
} from './notifications-empty'

export type NotificationFilter = 'all' | 'unread' | NotificationCategory

const EMPTY_STICKY: ReadonlySet<string> = new Set()

function matchesFilter(
  item: NotificationItem,
  filter: NotificationFilter,
  stickyUnread: ReadonlySet<string>,
) {
  if (filter === 'all') return true
  // Keep rows that were unread when the filter opened even after they
  // auto-mark-read, so viewing them doesn't make them vanish mid-read (#762).
  if (filter === 'unread')
    return item.read_at == null || stickyUnread.has(item.id)
  return item.category === filter
}

export interface NotificationsViewProps {
  items: NotificationItem[]
  /** Server-ordered category taxonomy — drives the filter pills. */
  categoryTypes: NotificationTaxonomy['types']
  unreadCount: number
  filter: NotificationFilter
  onFilterChange: (filter: NotificationFilter) => void
  onActivate: (notification: NotificationItem) => void
  onMarkAllRead: () => void
  /** Called with a row's id when it scrolls into view (auto mark-read). */
  onSeen?: (id: string) => void
  /** Ids to keep visible on the Unread filter after they auto-mark-read, so
   * viewing a row doesn't make it vanish mid-read (#762). See `useStickyUnread`. */
  stickyUnread?: ReadonlySet<string>
}

/** The full notifications page: a Bebas header, category filter pills, and the
 * filtered list (or an empty state). Pure — data + handlers come in as props. */
export function NotificationsView({
  items,
  categoryTypes,
  unreadCount,
  filter,
  onFilterChange,
  onActivate,
  onMarkAllRead,
  onSeen,
  stickyUnread = EMPTY_STICKY,
}: NotificationsViewProps) {
  const shown = items.filter((item) =>
    matchesFilter(item, filter, stickyUnread),
  )
  const filters: { key: NotificationFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    ...categoryTypes.map((type) => ({ key: type.key, label: type.short })),
  ]
  // An empty *list* is two different situations wearing one face, and they want
  // opposite next actions — see `NotificationsEmpty` (#901). A filter can only
  // come up empty while it is narrowing something, so `filter-empty` always has
  // a filter worth clearing.
  const emptyState: NotificationsEmptyState | null =
    shown.length > 0
      ? null
      : items.length === 0
        ? { kind: 'inbox-empty' }
        : {
            kind: 'filter-empty',
            filterLabel:
              filters.find((f) => f.key === filter)?.label ?? 'this filter',
          }

  return (
    <div className="mx-auto max-w-[760px] px-6 pt-9 pb-20">
      <div className="mb-1.5 flex items-end gap-3.5">
        <h1 className="font-display text-[44px] leading-none text-[color:var(--fg-1)]">
          NOTIFICATIONS
        </h1>
        {unreadCount > 0 ? (
          <span
            className="mb-1.5 rounded-full px-2.5 py-1 font-mono text-[13px] font-bold"
            style={{ color: 'var(--ball-500)', background: 'rgba(255,122,26,0.12)' }}
          >
            {unreadCount} unread
          </span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onMarkAllRead}
          disabled={unreadCount === 0}
          className="mb-1 rounded-lg border border-[color:var(--border-default)] px-3.5 py-2 text-[13px] font-semibold text-[color:var(--fg-3)] transition-colors enabled:hover:text-[color:var(--fg-1)] disabled:opacity-50"
        >
          Mark all read
        </button>
      </div>

      <div className="my-4 flex flex-wrap gap-2" role="group" aria-label="Filter notifications">
        {filters.map(({ key, label }) => {
          const active = filter === key
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(key)}
              className={cn(
                'rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors',
                active
                  ? 'border-transparent text-[color:var(--ink-950)]'
                  : 'border-[color:var(--border-default)] text-[color:var(--fg-2)]',
              )}
              style={active ? { background: 'var(--ball-500)' } : undefined}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div className="overflow-hidden rounded-[14px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-panel)]">
        {emptyState ? (
          <NotificationsEmpty
            state={emptyState}
            onShowAll={() => onFilterChange('all')}
          />
        ) : (
          <ul>
            {shown.map((item, i) => (
              <li
                key={item.id}
                className={
                  i < shown.length - 1
                    ? 'border-b border-[color:var(--ink-800)]'
                    : undefined
                }
              >
                <NotificationRow
                  notification={item}
                  onActivate={onActivate}
                  onSeen={onSeen}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
