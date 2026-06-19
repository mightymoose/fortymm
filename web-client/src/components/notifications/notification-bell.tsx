import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import {
  notificationFeedQueryOptions,
  useMarkAllNotificationsRead,
  useUnreadCount,
} from '@/api/notifications'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { NotificationDropdown } from './notification-bell/notification-dropdown'
import { useAutoMarkRead } from './use-auto-mark-read'
import { useFollowNotification } from './use-follow-notification'

/**
 * The topbar notification bell: an unread badge that polls in the background,
 * and a dropdown (fetched lazily on open) of recent notifications. Lives in the
 * app-shell actions row beside the user menu.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const unread = useUnreadCount()
  // Only pull the full feed once the dropdown is opened.
  const feed = useQuery({ ...notificationFeedQueryOptions(), enabled: open })
  const markAll = useMarkAllNotificationsRead()
  const follow = useFollowNotification()
  const markSeen = useAutoMarkRead()

  const unreadCount = unread.data?.unread_count ?? 0
  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : 'Notifications'
          }
          className={cn(
            'relative flex size-10 items-center justify-center rounded-[10px] border transition-colors',
            open
              ? 'border-[color:var(--border-default)] bg-[color:var(--bg-raised)]'
              : 'border-transparent hover:bg-[rgba(255,255,255,0.04)]',
          )}
        >
          <Bell
            size={20}
            className={
              open ? 'text-[color:var(--fg-1)]' : 'text-[color:var(--fg-2)]'
            }
          />
          {unreadCount > 0 ? (
            <span
              aria-hidden
              className="absolute top-1.5 right-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 font-mono text-[10px] font-bold"
              style={{
                background: 'var(--ball-500)',
                color: 'var(--ink-950)',
                boxShadow: '0 0 0 2px var(--ink-950)',
              }}
            >
              {badgeLabel}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[24rem] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <NotificationDropdown
          items={feed.data?.items ?? []}
          unreadCount={feed.data?.unread_count ?? 0}
          isLoading={feed.isLoading}
          isError={feed.isError}
          onActivate={(notification) => {
            follow(notification)
            setOpen(false)
          }}
          onMarkAllRead={() => markAll.mutate()}
          onSeen={markSeen}
          onSeeAll={() => {
            setOpen(false)
            void router.history.push('/notifications')
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
