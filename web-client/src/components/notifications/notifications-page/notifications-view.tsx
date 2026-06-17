import { Inbox } from 'lucide-react'
import type { NotificationItem } from '@/api/notifications'
import { cn } from '@/lib/utils'
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  type NotificationCategory,
} from '../notification-meta'
import { NotificationRow } from '../notification-row'

export type NotificationFilter = 'all' | 'unread' | NotificationCategory

const FILTERS: { key: NotificationFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  ...CATEGORY_ORDER.map((category) => ({
    key: category,
    label: CATEGORY_META[category].short,
  })),
]

function matchesFilter(item: NotificationItem, filter: NotificationFilter) {
  if (filter === 'all') return true
  if (filter === 'unread') return item.read_at == null
  return item.category === filter
}

export interface NotificationsViewProps {
  items: NotificationItem[]
  unreadCount: number
  filter: NotificationFilter
  onFilterChange: (filter: NotificationFilter) => void
  onActivate: (notification: NotificationItem) => void
  onMarkAllRead: () => void
}

/** The full notifications page: a Bebas header, category filter pills, and the
 * filtered list (or an empty state). Pure — data + handlers come in as props. */
export function NotificationsView({
  items,
  unreadCount,
  filter,
  onFilterChange,
  onActivate,
  onMarkAllRead,
}: NotificationsViewProps) {
  const shown = items.filter((item) => matchesFilter(item, filter))

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
        {FILTERS.map(({ key, label }) => {
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
        {shown.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <span className="mb-3.5 inline-flex size-14 items-center justify-center rounded-full bg-[color:var(--bg-card)] text-[color:var(--fg-muted)]">
              <Inbox size={26} />
            </span>
            <p className="text-base font-semibold text-[color:var(--fg-2)]">
              All caught up.
            </p>
            <p className="mt-1 text-[13px] text-[color:var(--fg-3)]">
              Nothing here. Go play.
            </p>
          </div>
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
                <NotificationRow notification={item} onActivate={onActivate} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
