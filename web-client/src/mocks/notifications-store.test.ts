import { isMatchId } from '@/lib/match-id'
import { CATEGORY_VISUAL } from '@/components/notifications/notification-meta'
import { findMatch } from '@/mocks/match-store'
import { notificationTaxonomy } from '@/test/factories'

/** The seeded feed, as the dev bell fetches it. */
async function fetchSeededFeed(): Promise<{
  items: { link: string | null; category: string }[]
}> {
  const response = await fetch(`${window.location.origin}/v1/notifications`)
  return response.json()
}

/** The `<id>` in a `/matches/<id>` link, or null for a link that goes elsewhere. */
function matchIdIn(link: string | null): string | null {
  const match = link?.match(/^\/matches\/([^/?#]+)/)
  return match ? match[1] : null
}

describe('the seeded notification feed (#958)', () => {
  // A deep link is a promise that tapping it lands somewhere. The seeded
  // "Accept your score" notification pointed at `/matches/m-1`, which broke
  // that promise twice over: `m-1` is not a UUID, so the route rejected it
  // before fetching — and no match with that id existed in the store anyway.
  it('deep-links only to matches the router accepts and the store actually holds', async () => {
    const feed = await fetchSeededFeed()

    const matchIds = feed.items.map((item) => matchIdIn(item.link)).filter((id) => id !== null)

    expect(matchIds.length).toBeGreaterThan(0)
    expect(matchIds.filter((id) => !isMatchId(id))).toEqual([])
    expect(matchIds.filter((id) => findMatch(id) === undefined)).toEqual([])
  })

  // The `match_calls` category (ADR "the schedule is solved; the call is
  // pinned"): the feed must be able to carry called / moved / cancelled items in
  // dev and tests, which takes three things agreeing — a seeded item, a visual
  // for the row to draw, and a taxonomy label for the preferences matrix.
  it('seeds a match_calls item, and every seeded category is one the UI can draw', async () => {
    const feed = await fetchSeededFeed()

    expect(feed.items.some((item) => item.category === 'match_calls')).toBe(true)
    const drawable = new Set(Object.keys(CATEGORY_VISUAL))
    expect(feed.items.filter((item) => !drawable.has(item.category))).toEqual([])
  })

  it('labels match_calls in the taxonomy with the server seed’s own words', () => {
    const taxonomy = notificationTaxonomy()
    // Mirrors migration 0015's seed row — the label the preferences matrix and
    // the feed filters render.
    expect(taxonomy.types).toContainEqual({
      key: 'match_calls',
      label: 'Match calls',
      short: 'Calls',
    })
  })
})
