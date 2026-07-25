import { z } from 'zod'

import type { NotificationCategory } from '../notification-meta'
import type { NotificationFilter } from './notifications-view'

// The active filter lives in the URL (`?filter=…`), Zod-parsed at the route
// boundary via `validateSearch` — so a filtered view is linkable, survives a
// reload, and steps through browser Back (#999, per the web-client Boundaries
// convention).
//
// Category slugs are open-ended: they come from the server taxonomy
// (`/v1/notification-taxonomy`), not a client-side enum, so the boundary can't
// know the valid set. It therefore accepts any string; a malformed value (a
// non-string, an array) `.catch('all')`. `.optional()` keeps the default (All)
// off the URL entirely — an absent param is undefined, not the literal `all`,
// so reselecting All returns to a clean `/notifications` (the players/matches
// `.optional().catch(...)` precedent). An unknown *slug* (a syntactically-valid
// string that no category owns) is degraded to All in the page by
// `normalizeNotificationFilter`, once the taxonomy is known.
export const notificationsSearchSchema = z.object({
  filter: z.string().optional().catch('all'),
})

export type NotificationsSearch = z.infer<typeof notificationsSearchSchema>

/**
 * Resolve the raw URL `filter` to a filter the view understands: `all`,
 * `unread`, or a category slug the server taxonomy actually defines. An absent
 * param, or a stale/bogus slug, degrades to `all` rather than rendering an
 * empty "no notifications match" view for a filter that can never match.
 */
export function normalizeNotificationFilter(
  raw: string | undefined,
  categoryKeys: readonly NotificationCategory[],
): NotificationFilter {
  if (raw === undefined || raw === 'all' || raw === 'unread') {
    return raw ?? 'all'
  }
  return (categoryKeys as readonly string[]).includes(raw)
    ? (raw as NotificationCategory)
    : 'all'
}
