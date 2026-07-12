import { isMatchId } from '@/lib/match-id'
import { findMatch } from '@/mocks/match-store'

/** The seeded feed, as the dev bell fetches it. */
async function fetchSeededFeed(): Promise<{ items: { link: string | null }[] }> {
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
})
