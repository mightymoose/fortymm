import type { Guest } from './match-api'

// Composed-stack API helper for reading a user's **in-app notification feed**
// (`GET /v1/notifications`) — the persisted record of what the platform told them.
//
// A spec whose subject is "what was this player told" reads the feed here rather
// than the bell: the feed is the durable fact, the bell is one rendering of it, and
// an assertion like "exactly one call notice and no correction" needs a count the
// UI does not expose.

const API = '/api/v1'

/** One notification as the feed carries it — the fields a spec asserts on. */
export interface NotificationItem {
  readonly id: string
  readonly category: string
  readonly title: string
  readonly body: string
  readonly link: string | null
}

/** Read `viewer`'s feed, newest first. */
export async function listNotifications(viewer: Guest): Promise<NotificationItem[]> {
  const res = await viewer.ctx.get(`${API}/notifications`)
  if (!res.ok()) {
    throw new Error(`list notifications failed: ${res.status()} ${await res.text()}`)
  }
  const feed: unknown = await res.json()
  if (typeof feed !== 'object' || feed === null || !('items' in feed) ||
    !Array.isArray(feed.items)) throw new Error('invalid notification feed')
  return feed.items.map((item: unknown): NotificationItem => {
    if (typeof item !== 'object' || item === null ||
      !('id' in item) || typeof item.id !== 'string' ||
      !('category' in item) || typeof item.category !== 'string' ||
      !('title' in item) || typeof item.title !== 'string' ||
      !('body' in item) || typeof item.body !== 'string' ||
      !('link' in item) || (item.link !== null && typeof item.link !== 'string')) {
      throw new Error('invalid notification item')
    }
    return { id: item.id, category: item.category, title: item.title,
      body: item.body, link: item.link }
  })
}

/** The feed entries whose title starts with `prefix` — how a spec counts one
 * message kind (`You're up soon — …`, `Your match moved to …`) without pinning the
 * table label the rest of the title carries. */
export function noticesTitled(
  items: ReadonlyArray<NotificationItem>,
  prefix: string,
): NotificationItem[] {
  return items.filter((item) => item.title.startsWith(prefix))
}
