import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type TestNotificationResult =
  components['schemas']['TestNotificationResponse']
export type NotificationItem = components['schemas']['NotificationItem']
export type NotificationCategory = components['schemas']['NotificationCategory']
export type NotificationChannel = components['schemas']['NotificationChannel']
export type NotificationFeed = components['schemas']['NotificationFeed']
export type UnreadCount = components['schemas']['UnreadCountResponse']
export type NotificationPreferences =
  components['schemas']['NotificationPreferences']
export type NotificationPreferencesUpdate =
  components['schemas']['NotificationPreferencesUpdate']
export type BroadcastRequest = components['schemas']['BroadcastRequest']
export type BroadcastResponse = components['schemas']['BroadcastResponse']
export type BroadcastRecipient = components['schemas']['BroadcastRecipient']
export type BroadcastRecipientList =
  components['schemas']['BroadcastRecipientList']
export type NotificationTaxonomy =
  components['schemas']['NotificationTaxonomy']

// All notification queries hang off this prefix so a single
// `invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY })` refreshes the bell
// badge, the dropdown, and the list page together after any mutation.
export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const
export const NOTIFICATION_PREFERENCES_QUERY_KEY = [
  'notification-preferences',
] as const
export const NOTIFICATION_TAXONOMY_QUERY_KEY = [
  'notification-taxonomy',
] as const

// Categories that are defined + seeded server-side but that nothing ever emits
// yet, so their filter pill and preferences toggle would be decorative and
// misleading. We hide them CLIENT-SIDE in the taxonomy and preferences query
// selects — so every surface built from those lists drops them: the notifications
// filter pills and the admin broadcast category picker (both render the taxonomy
// `types`), and the preferences matrix. Filtering at the query layer rather than
// at each render site is deliberate — one revert point that can't miss a surface,
// at the cost of also dropping the category from the admin broadcast picker (fine:
// a Rating broadcast would be un-filterable and un-opt-out-able while the pill and
// pref are gone). The server taxonomy is untouched. The follow-up fan-out feature
// (#1176) starts emitting `rating_change` and un-hides it by emptying this list.
export const HIDDEN_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'rating_change',
]

function isHiddenCategory(category: NotificationCategory): boolean {
  return HIDDEN_NOTIFICATION_CATEGORIES.includes(category)
}

// The bell badge polls this lightweight count so a notification that arrives in
// another tab/device surfaces without a manual refresh. We poll rather than
// long-poll/WebSocket deliberately: the feed is low-frequency and per-user, so a
// cheap interval GET beats standing up socket/pub-sub infra.
const UNREAD_POLL_MS = 1000 * 60
// Whenever the full feed is actually on screen (bell open, notifications page
// mounted) refresh it on a tighter cadence so it stays live without a reload.
// Off-screen the query isn't mounted, so nothing polls.
const FEED_POLL_MS = 1000 * 30

/**
 * Fire a test push to the current user's registered iOS devices. The backend
 * fans out to every device token the signed-in user has registered (so you must
 * be signed into the same account in the iOS app) and reports how many were
 * delivered. Callers await via `mutateAsync` and catch `ApiError` — a 503 means
 * push isn't configured on the server.
 */
export function useSendTestNotification() {
  return useMutation({
    mutationFn: async (): Promise<TestNotificationResult> =>
      unwrap('send test notification', await api.POST('/v1/notifications/test')),
  })
}

/** The recent notifications + unread total — the bell dropdown and the
 * notifications page both read this. */
export function notificationFeedQueryOptions() {
  return queryOptions({
    queryKey: [...NOTIFICATIONS_QUERY_KEY, 'feed'] as const,
    queryFn: async (): Promise<NotificationFeed> =>
      unwrap('load notifications', await api.GET('/v1/notifications')),
    refetchInterval: FEED_POLL_MS,
  })
}

export function useNotificationFeed() {
  return useQuery(notificationFeedQueryOptions())
}

/** Just the unread count — drives the bell badge and polls in the background. */
export function unreadCountQueryOptions() {
  return queryOptions({
    queryKey: [...NOTIFICATIONS_QUERY_KEY, 'unread-count'] as const,
    queryFn: async (): Promise<UnreadCount> =>
      unwrap(
        'load unread count',
        await api.GET('/v1/notifications/unread-count'),
      ),
    refetchInterval: UNREAD_POLL_MS,
  })
}

export function useUnreadCount() {
  return useQuery(unreadCountQueryOptions())
}

export function useMarkNotificationRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<NotificationItem> =>
      unwrap(
        'mark notification read',
        await api.POST('/v1/notifications/{notification_id}/read', {
          params: { path: { notification_id: id } },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY })
    },
  })
}

/**
 * Mark a batch of notifications read in one request. The "auto-mark on screen"
 * flow debounces the ids of rows that scroll into view and flushes them here, so
 * a burst of newly-seen rows costs one round-trip instead of one-per-row.
 *
 * We optimistically clear those rows' `read_at` and drop the unread badge so the
 * count falls the instant a notification is seen — the debounce would otherwise
 * leave the badge stale for ~1s. On success we reconcile *only* the cheap
 * unread-count query against the server, so the badge converges to the true count
 * even when the optimistic decrement was a no-op or wrong (the count query hadn't
 * loaded, or the flushed ids weren't in the on-screen feed) — the failure mode of
 * #1112, where the badge stuck stale until the 60s poll. We deliberately leave the
 * full feed's optimistic state in place rather than invalidating it: re-fetching
 * the whole feed on every debounced batch would thrash the list while scrolling,
 * and the FEED_POLL reconciles any drift there. A failed write rolls the whole
 * optimistic state back and re-syncs to server truth.
 */
export function useMarkNotificationsRead() {
  const qc = useQueryClient()
  const feedKey = [...NOTIFICATIONS_QUERY_KEY, 'feed'] as const
  const countKey = [...NOTIFICATIONS_QUERY_KEY, 'unread-count'] as const
  return useMutation({
    mutationFn: async (ids: string[]) =>
      unwrap(
        'mark notifications read',
        await api.POST('/v1/notifications/read', { body: { ids } }),
      ),
    onMutate: async (ids) => {
      const idSet = new Set(ids)
      await qc.cancelQueries({ queryKey: NOTIFICATIONS_QUERY_KEY })
      const prevFeed = qc.getQueryData<NotificationFeed>(feedKey)
      const prevCount = qc.getQueryData<UnreadCount>(countKey)
      // Decrement by how many targeted rows are *currently* unread, so a re-seen
      // (already-read) row doesn't drive the badge negative.
      const newlyRead =
        prevFeed?.items.filter((n) => idSet.has(n.id) && n.read_at == null)
          .length ?? 0
      const readAt = new Date().toISOString()
      if (prevFeed) {
        qc.setQueryData<NotificationFeed>(feedKey, {
          ...prevFeed,
          items: prevFeed.items.map((n) =>
            idSet.has(n.id) && n.read_at == null ? { ...n, read_at: readAt } : n,
          ),
          unread_count: Math.max(0, prevFeed.unread_count - newlyRead),
        })
      }
      if (prevCount) {
        qc.setQueryData<UnreadCount>(countKey, {
          unread_count: Math.max(0, prevCount.unread_count - newlyRead),
        })
      }
      return { prevFeed, prevCount }
    },
    // Reconcile the badge to server truth by invalidating *only* the lightweight
    // unread-count query (never the full feed — that would thrash the list on
    // every debounced batch while scrolling). This makes the decrement reliable
    // even when the optimistic pass couldn't do it: a mounted badge refetches the
    // real count instead of sticking stale until the poll (#1112).
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: countKey })
    },
    onError: (_err, _ids, context) => {
      if (context?.prevFeed) qc.setQueryData(feedKey, context.prevFeed)
      if (context?.prevCount) qc.setQueryData(countKey, context.prevCount)
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY })
    },
  })
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      unwrap(
        'mark all notifications read',
        await api.POST('/v1/notifications/read-all'),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY })
    },
  })
}

/** The channel masters + per-category matrix for the preferences page. */
export function notificationPreferencesQueryOptions() {
  return queryOptions({
    queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY,
    queryFn: async (): Promise<NotificationPreferences> =>
      unwrap(
        'load notification preferences',
        await api.GET('/v1/notification-preferences'),
      ),
    // Drop hidden categories from the matrix — its rows come from
    // `categories`, a separate query from the taxonomy that feeds the pills, so
    // it has to be filtered here too (#998). See HIDDEN_NOTIFICATION_CATEGORIES.
    select: (prefs) => ({
      ...prefs,
      categories: prefs.categories.filter(
        (row) => !isHiddenCategory(row.category),
      ),
    }),
  })
}

export function useNotificationPreferences() {
  return useQuery(notificationPreferencesQueryOptions())
}

/** The notification "display taxonomy" — the ordered, server-owned labels for
 * categories and channels every surface renders. Reference data: it changes only
 * with a deploy, so we never refetch it within a session. */
export function notificationTaxonomyQueryOptions() {
  return queryOptions({
    queryKey: NOTIFICATION_TAXONOMY_QUERY_KEY,
    queryFn: async (): Promise<NotificationTaxonomy> =>
      unwrap(
        'load notification taxonomy',
        await api.GET('/v1/notification-taxonomy'),
      ),
    staleTime: Infinity,
    // Drop hidden categories from the taxonomy so neither the filter pills nor
    // the admin broadcast category picker (both map over `types`) renders one for
    // a notification that can't arrive (#998). See HIDDEN_NOTIFICATION_CATEGORIES.
    select: (taxonomy) => ({
      ...taxonomy,
      types: taxonomy.types.filter((type) => !isHiddenCategory(type.key)),
    }),
  })
}

export function useNotificationTaxonomy() {
  return useQuery(notificationTaxonomyQueryOptions())
}

export function useUpdateNotificationPreferences() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (
      update: NotificationPreferencesUpdate,
    ): Promise<NotificationPreferences> =>
      unwrap(
        'update notification preferences',
        await api.PATCH('/v1/notification-preferences', { body: update }),
      ),
    // The PATCH response is the freshly server-resolved state, so seed the cache
    // directly rather than round-tripping a refetch (keeps the matrix snappy).
    onSuccess: (prefs) => {
      qc.setQueryData(NOTIFICATION_PREFERENCES_QUERY_KEY, prefs)
    },
  })
}

/** Players the admin broadcast tool can target, filtered by username. */
export function broadcastRecipientsQueryOptions(query: string) {
  const trimmed = query.trim()
  return queryOptions({
    queryKey: ['broadcast-recipients', trimmed] as const,
    queryFn: async (): Promise<BroadcastRecipientList> =>
      unwrap(
        'load broadcast recipients',
        await api.GET('/v1/notifications/broadcast/recipients', {
          params: { query: trimmed ? { q: trimmed } : {} },
        }),
      ),
  })
}

export function useBroadcastRecipients(query: string) {
  return useQuery(broadcastRecipientsQueryOptions(query))
}

export function useSendBroadcast() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: BroadcastRequest): Promise<BroadcastResponse> =>
      unwrap(
        'send broadcast',
        await api.POST('/v1/notifications/broadcast', { body }),
      ),
    // A broadcast may land in the admin's own feed — refresh it.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY })
    },
  })
}
