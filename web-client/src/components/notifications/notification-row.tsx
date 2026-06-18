import type { NotificationItem } from '@/api/notifications'
import { cn } from '@/lib/utils'
import { CATEGORY_VISUAL } from './notification-meta'
import { relativeTime } from './relative-time'

export interface NotificationRowProps {
  notification: NotificationItem
  /** Dropdown sizing (tighter) vs. full notifications-page sizing. */
  compact?: boolean
  /** Injected for stable relative-time in tests. */
  now?: Date
  /** Fired on click — the parent marks the row read and follows its link. */
  onActivate?: (notification: NotificationItem) => void
}

/**
 * One notification, shared by the bell dropdown and the notifications page.
 * Unread rows use the "card" emphasis — a soft ball-orange wash across the whole
 * row. The whole row is a single button (click marks it read and follows its
 * deep link); the call-to-action is a visual pill inside that button.
 */
export function NotificationRow({
  notification,
  compact = false,
  now,
  onActivate,
}: NotificationRowProps) {
  const visual = CATEGORY_VISUAL[notification.category]
  const { Icon } = visual
  const unread = notification.read_at == null
  const delta = notification.delta
  const deltaUp = delta?.trim().startsWith('+') ?? false

  return (
    <button
      type="button"
      onClick={() => onActivate?.(notification)}
      data-unread={unread}
      className={cn(
        'flex w-full items-start gap-3 text-left transition-colors',
        compact ? 'px-3.5 py-3' : 'px-4 py-4',
        'hover:bg-[rgba(255,255,255,0.025)]',
      )}
      style={unread ? { background: 'rgba(255, 122, 26, 0.06)' } : undefined}
    >
      {unread ? <span className="sr-only">Unread.</span> : null}
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-[10px]',
          compact ? 'size-9' : 'size-10',
        )}
        style={{ background: visual.tint, color: visual.color }}
      >
        <Icon size={compact ? 17 : 20} strokeWidth={1.9} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="mb-0.5 flex items-start gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 leading-snug',
              compact ? 'text-sm' : 'text-[15px]',
              unread
                ? 'font-bold text-[color:var(--fg-1)]'
                : 'font-semibold text-[color:var(--fg-2)]',
            )}
          >
            {notification.title}
          </span>
          {delta ? (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[13px] font-bold tabular-nums"
              style={{
                color: deltaUp ? 'var(--serve-500)' : 'var(--loss)',
                background: deltaUp
                  ? 'rgba(0, 226, 154, 0.14)'
                  : 'rgba(255, 77, 109, 0.14)',
              }}
            >
              {delta}
            </span>
          ) : null}
        </span>

        <span
          className={cn(
            'line-clamp-2 leading-normal text-[color:var(--fg-3)]',
            compact ? 'text-[12.5px]' : 'text-[13.5px]',
          )}
        >
          {notification.body}
        </span>

        {notification.action_label ? (
          <span
            className={cn(
              'mt-2 inline-flex rounded-lg border px-3 py-1.5 font-semibold',
              compact ? 'text-xs' : 'text-[13px]',
            )}
            style={{
              color: visual.color,
              borderColor: 'var(--border-default)',
            }}
          >
            {notification.action_label}
          </span>
        ) : null}
      </span>

      <span className="flex shrink-0 flex-col items-end gap-2">
        <time
          dateTime={notification.created_at}
          className="font-mono text-[11px] font-medium tracking-wide whitespace-nowrap text-[color:var(--fg-muted)]"
        >
          {relativeTime(notification.created_at, now)}
        </time>
      </span>
    </button>
  )
}
