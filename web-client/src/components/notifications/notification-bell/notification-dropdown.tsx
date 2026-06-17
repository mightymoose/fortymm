import { ChevronRight, Inbox } from 'lucide-react'
import type { NotificationItem } from '@/api/notifications'
import { NotificationRow } from '../notification-row'

const DROPDOWN_LIMIT = 6

export interface NotificationDropdownProps {
  items: NotificationItem[]
  unreadCount: number
  isLoading: boolean
  isError?: boolean
  onActivate: (notification: NotificationItem) => void
  onMarkAllRead: () => void
  onSeeAll: () => void
}

/**
 * The bell's dropdown panel: a header (unread count + "mark all read"), the
 * most recent notifications, and a "see all" footer. Purely presentational —
 * all data + navigation come in as props.
 */
export function NotificationDropdown({
  items,
  unreadCount,
  isLoading,
  isError = false,
  onActivate,
  onMarkAllRead,
  onSeeAll,
}: NotificationDropdownProps) {
  const shown = items.slice(0, DROPDOWN_LIMIT)

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] px-4 py-3.5">
        <h2 className="text-[15px] font-semibold text-[color:var(--fg-1)]">
          Notifications
        </h2>
        {unreadCount > 0 ? (
          <span
            className="rounded-full px-2 py-0.5 font-mono text-[11px] font-bold"
            style={{ color: 'var(--ball-500)', background: 'rgba(255,122,26,0.12)' }}
          >
            {unreadCount} new
          </span>
        ) : null}
        <div className="flex-1" />
        {unreadCount > 0 ? (
          <button
            type="button"
            onClick={onMarkAllRead}
            className="text-xs font-semibold text-[color:var(--fg-3)] transition-colors hover:text-[color:var(--fg-1)]"
          >
            Mark all read
          </button>
        ) : null}
      </div>

      <div className="max-h-[26rem] overflow-y-auto">
        {isLoading ? (
          <p className="px-4 py-10 text-center text-[13px] text-[color:var(--fg-muted)]">
            Loading…
          </p>
        ) : isError ? (
          <p className="px-4 py-10 text-center text-[13px] text-[color:var(--loss)]">
            Couldn't load notifications. Try again.
          </p>
        ) : shown.length === 0 ? (
          <div className="px-5 py-12 text-center">
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
                <NotificationRow notification={item} compact onActivate={onActivate} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={onSeeAll}
        className="flex items-center justify-center gap-1.5 border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] py-3 text-[13px] font-semibold text-[color:var(--fg-2)] transition-colors hover:text-[color:var(--ball-500)]"
      >
        See all notifications <ChevronRight size={15} />
      </button>
    </div>
  )
}
