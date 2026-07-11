import { USATT_LEAGUE_ID } from '@/mocks/factories/players/player-league.factory'

import {
  buildLeagueRowView,
  buildLeaguesView,
  buildSecondLeagueRowView,
  buildSingleLeagueView,
} from './leagues-card-display.factory'
import { leaguesCardDisplayPage } from './leagues-card-display.page'

describe('LeaguesCardDisplay', () => {
  it('renders a row per league — the name, the Default badge, and the rating ON that ladder', async () => {
    leaguesCardDisplayPage.render({ leagues: buildLeaguesView() })

    await leaguesCardDisplayPage.findLeaguesCard()

    expect(leaguesCardDisplayPage.getLeagueRows()).toHaveLength(2)
    // Two ladders, two *different* ratings. There is no such thing as this
    // player's rating "in general" (ADR-0915) — which is the whole reason the
    // card exists.
    expect(leaguesCardDisplayPage.getLeagueRating('FortyMM')).toBe('1687')
    expect(leaguesCardDisplayPage.getLeagueRating('USATT')).toBe('1642')
    // Only the default league wears the badge.
    expect(leaguesCardDisplayPage.queryDefaultBadge('FortyMM')).toBeInTheDocument()
    expect(leaguesCardDisplayPage.queryDefaultBadge('USATT')).not.toBeInTheDocument()
  })

  it('makes the rows the CONTROL — each links to this profile with that league selected', async () => {
    // The rows are links, not decoration: clicking one rebinds the rating half of
    // the page. If these were <li>s or unlinked buttons, the selection could not
    // survive a reload or be shared, and this test would fail.
    leaguesCardDisplayPage.render({ leagues: buildLeaguesView() })

    await leaguesCardDisplayPage.findLeaguesCard()

    expect(leaguesCardDisplayPage.getLeagueHref('USATT')).toBe(
      `/players/p-1?league=${USATT_LEAGUE_ID}`,
    )
  })

  it('links the DEFAULT league to a clean URL — no ?league= at all', async () => {
    // The default league is what a URL with no param *means* (CONTEXT.md §
    // Default league), so spelling it out would put a redundant uuid in the URL
    // of the overwhelmingly common visit. A `?league=<default-id>` here is the
    // bug this test exists to catch.
    leaguesCardDisplayPage.render({ leagues: buildLeaguesView() })

    await leaguesCardDisplayPage.findLeaguesCard()

    expect(leaguesCardDisplayPage.getLeagueHref('FortyMM')).toBe('/players/p-1')
    expect(leaguesCardDisplayPage.getLeagueHref('FortyMM')).not.toContain('league=')
  })

  it('marks exactly one row as the selected ladder', async () => {
    leaguesCardDisplayPage.render({
      leagues: buildLeaguesView({
        rows: [
          buildLeagueRowView({ isSelected: false }),
          buildSecondLeagueRowView({ isSelected: true }),
        ],
      }),
    })

    await leaguesCardDisplayPage.findLeaguesCard()

    // `getSelectedLeagueRow` throws unless there is exactly one — so this also
    // proves the card never highlights two ladders, or none.
    expect(leaguesCardDisplayPage.getSelectedLeagueName()).toBe('USATT')
  })

  it('prints an em dash — never a 0 — for a league the player holds no rating in', async () => {
    // Belonging to a ladder and holding a rating on it are different facts: the
    // API outer-joins the rating, so a member awaiting their first one still gets
    // a row. A "0" would say they are the worst player on it.
    leaguesCardDisplayPage.render({
      leagues: buildLeaguesView({
        rows: [
          buildLeagueRowView(),
          buildSecondLeagueRowView({ rating: '—' }),
        ],
      }),
    })

    await leaguesCardDisplayPage.findLeaguesCard()

    expect(leaguesCardDisplayPage.getLeagueRating('USATT')).toBe('—')
    expect(leaguesCardDisplayPage.getLeagueRating('USATT')).not.toContain('0')
  })

  it('still renders for a player in only the default league — one row, not nothing', async () => {
    // Every real user today. The single-row card is the correct rendering, not a
    // degenerate one to be hidden away: hiding it would delete the only
    // affordance that makes the page legible when the second league lands.
    leaguesCardDisplayPage.render({ leagues: buildSingleLeagueView() })

    await leaguesCardDisplayPage.findLeaguesCard()

    expect(leaguesCardDisplayPage.getLeagueRows()).toHaveLength(1)
    expect(leaguesCardDisplayPage.getSelectedLeagueName()).toBe('FortyMM')
  })
})
