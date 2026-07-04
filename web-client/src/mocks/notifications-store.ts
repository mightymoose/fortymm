import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import {
  notificationPreferences,
  notificationTaxonomy,
} from '@/test/factories'

type NotificationItem = components['schemas']['NotificationItem']
type NotificationPreferences = components['schemas']['NotificationPreferences']
type NotificationPreferencesUpdate =
  components['schemas']['NotificationPreferencesUpdate']
type BroadcastRequest = components['schemas']['BroadcastRequest']
type BroadcastRecipient = components['schemas']['BroadcastRecipient']

// A small in-memory feed so the dev bell + pages have something to render.
// Mutated by mark-read / broadcast so the dev UI feels live.
let feed: NotificationItem[] = [
  {
    id: 'mn-1',
    category: 'result_confirm',
    title: 'Accept your score',
    body: 'def. Patel, M. — you logged 3–1. Tap to accept.',
    link: '/matches/m-1',
    action_label: 'Review',
    delta: null,
    read_at: null,
    created_at: '2026-06-17T11:59:00.000Z',
  },
  {
    id: 'mn-2',
    category: 'opponent',
    title: 'Okafor, D. challenged you',
    body: 'Singles · Downtown TT · Thu 20:30',
    link: null,
    action_label: 'Accept',
    delta: null,
    read_at: null,
    created_at: '2026-06-17T11:42:00.000Z',
  },
  {
    id: 'mn-3',
    category: 'rating_change',
    title: 'Rating +12',
    body: "You're now 1,847. Best of the month.",
    link: null,
    action_label: null,
    delta: '+12',
    read_at: '2026-06-17T11:05:00.000Z',
    created_at: '2026-06-17T11:00:00.000Z',
  },
  {
    id: 'mn-4',
    category: 'tournament',
    title: 'Spring Open · R16 posted',
    body: 'You play the winner of Tran / Chen.',
    link: null,
    action_label: 'See draw',
    delta: null,
    read_at: '2026-06-16T20:00:00.000Z',
    created_at: '2026-06-16T18:00:00.000Z',
  },
]

// Seed the dev mock with push + email needing setup so the preferences page
// exercises its channel-setup nudges (the all-set-up state hides them).
let prefs: NotificationPreferences = (() => {
  const p = notificationPreferences()
  p.channels = p.channels.map((c) =>
    c.channel === 'push'
      ? { ...c, setup_required: true, destination: 'No devices yet — open the app' }
      : c.channel === 'email'
        ? { ...c, setup_required: true, destination: 'Pending — check your inbox' }
        : c,
  )
  return p
})()

const RECIPIENTS: BroadcastRecipient[] = [
  { id: 'u-1', username: 'nguyen.t' },
  { id: 'u-2', username: 'okafor.d' },
  { id: 'u-3', username: 'silva.r' },
  { id: 'u-4', username: 'patel.m' },
  { id: 'u-5', username: 'johansen.a' },
]

const unreadCount = () => feed.filter((n) => n.read_at == null).length

function applyPreferenceUpdate(update: NotificationPreferencesUpdate) {
  for (const channel of update.channels ?? []) {
    prefs = {
      ...prefs,
      channels: prefs.channels.map((c) =>
        c.channel === channel.channel && !c.locked && c.available
          ? { ...c, enabled: channel.enabled }
          : c,
      ),
    }
  }
  for (const cell of update.cells ?? []) {
    prefs = {
      ...prefs,
      categories: prefs.categories.map((category) =>
        category.category === cell.category
          ? {
              ...category,
              cells: category.cells.map((c) =>
                c.channel === cell.channel && !c.locked
                  ? { ...c, enabled: cell.enabled }
                  : c,
              ),
            }
          : category,
      ),
    }
  }
}

export const notificationHandlers = [
  http.get('*/v1/notification-taxonomy', () =>
    HttpResponse.json(notificationTaxonomy()),
  ),

  http.get('*/v1/notifications/unread-count', () =>
    HttpResponse.json({ unread_count: unreadCount() }),
  ),

  http.get('*/v1/notifications/broadcast/recipients', ({ request }) => {
    const q = new URL(request.url).searchParams.get('q')?.toLowerCase() ?? ''
    const matched = q
      ? RECIPIENTS.filter((r) => r.username.toLowerCase().includes(q))
      : RECIPIENTS
    return HttpResponse.json({ recipients: matched, total: matched.length })
  }),

  http.post('*/v1/notifications/broadcast', async ({ request }) => {
    const body = (await request.json()) as BroadcastRequest
    const recipients =
      body.recipients.mode === 'all'
        ? RECIPIENTS.length
        : body.recipients.user_ids.length
    return HttpResponse.json({ recipients, queued: true })
  }),

  http.get('*/v1/notifications', () =>
    HttpResponse.json({
      items: [...feed].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
      unread_count: unreadCount(),
    }),
  ),

  http.post('*/v1/notifications/read', async ({ request }) => {
    const { ids } = (await request.json()) as { ids: string[] }
    const targeted = new Set(ids)
    let marked = 0
    feed = feed.map((n) => {
      if (targeted.has(n.id) && n.read_at == null) {
        marked += 1
        return { ...n, read_at: '2026-06-17T12:00:00.000Z' }
      }
      return n
    })
    return HttpResponse.json({ marked })
  }),

  http.post('*/v1/notifications/read-all', () => {
    let marked = 0
    feed = feed.map((n) => {
      if (n.read_at == null) {
        marked += 1
        return { ...n, read_at: '2026-06-17T12:00:00.000Z' }
      }
      return n
    })
    return HttpResponse.json({ marked })
  }),

  http.post('*/v1/notifications/:id/read', ({ params }) => {
    const id = params.id as string
    const item = feed.find((n) => n.id === id)
    if (!item) {
      return HttpResponse.json(
        { detail: 'Notification not found.' },
        { status: 404 },
      )
    }
    const updated = { ...item, read_at: item.read_at ?? '2026-06-17T12:00:00.000Z' }
    feed = feed.map((n) => (n.id === id ? updated : n))
    return HttpResponse.json(updated)
  }),

  http.get('*/v1/notification-preferences', () => HttpResponse.json(prefs)),

  http.patch('*/v1/notification-preferences', async ({ request }) => {
    applyPreferenceUpdate((await request.json()) as NotificationPreferencesUpdate)
    return HttpResponse.json(prefs)
  }),
]
