import { HttpResponse } from 'msw'

import { playerByIdQueryOptions } from '@/api/players'
import {
  buildEmptyCareer,
  buildPlayerCareer,
  buildPlayerDetail,
  buildPlayerStreak,
} from '@/mocks/factories/players/player-detail.factory'
import { waitFor } from '@/test/utilities'

import { careerCardQuery, type CareerView } from './career-card-query'
import { careerCardQueryPage } from './career-card-query.page'

/** Resolve the query against one bundle and hand back the projected view. */
async function selectFrom(
  overrides: Parameters<typeof buildPlayerDetail>[0],
): Promise<CareerView> {
  careerCardQueryPage.mockEndpoint(() =>
    HttpResponse.json(buildPlayerDetail(overrides)),
  )
  const { result } = careerCardQueryPage.render()
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  return result.current.data!
}

const tileValue = (view: CareerView, label: string) =>
  view.tiles.find((tile) => tile.label === label)?.value

describe('careerCardQuery', () => {
  it('reads the win rate as a SHARE — 0.375 is 37.5%, not 0.375% and not 0%', async () => {
    // The wire's `win_rate` is a share in [0, 1] despite the name. Printing it
    // raw would say "0.375%"; rounding it as a whole number would say "0%".
    const view = await selectFrom({
      career: buildPlayerCareer({ decided: 40, wins: 15, losses: 25, win_rate: 0.375 }),
    })

    expect(view.ring.label).toBe('37.5%')
    expect(view.ring.share).toBe(0.375)
  })

  it('rounds a repeating share to one decimal', async () => {
    const view = await selectFrom({
      career: buildPlayerCareer({ win_rate: 24 / 35 }),
    })

    expect(view.ring.label).toBe('68.6%')
  })

  it('reads the games-won share the same way — a finer read than W–L', async () => {
    const view = await selectFrom({
      career: buildPlayerCareer({ games_won_pct: 0.582 }),
    })

    expect(tileValue(view, 'Games won')).toBe('58.2%')
  })

  it('renders an em dash — NEVER "0%" — for a player who has decided nothing', async () => {
    // `win_rate` and `games_won_pct` arrive `null`, not `0`: a zero would claim
    // this player loses every match they play, which is a lie about someone who
    // has played none to a finish.
    const view = await selectFrom({ career: buildEmptyCareer() })

    expect(view.ring.label).toBe('—')
    expect(view.ring.label).not.toContain('0%')
    expect(view.ring.share).toBeNull()
    expect(tileValue(view, 'Games won')).toBe('—')
    expect(tileValue(view, 'Best streak')).toBe('—')
    expect(view.streak).toBeNull()
  })

  it('still says 0% for a player who HAS decided matches and lost every one', async () => {
    // The other side of the same coin: a real 0 is a true statement, and the
    // formatter must branch on `null`, not on falsiness.
    const view = await selectFrom({
      career: buildPlayerCareer({
        decided: 6,
        wins: 0,
        losses: 6,
        win_rate: 0,
        games_won_pct: 0,
        current_streak: buildPlayerStreak({ kind: 'L', n: 6 }),
        best_streak: null,
      }),
    })

    expect(view.ring.label).toBe('0%')
    expect(view.ring.share).toBe(0)
    expect(tileValue(view, 'Games won')).toBe('0%')
    // …and never having won, they have no best *winning* streak.
    expect(tileValue(view, 'Best streak')).toBe('—')
  })

  it('reports the record off `career`, not off the league-scoped top-level W–L', async () => {
    // Career is cross-league (ADR-0915). The bundle's top-level wins/losses are
    // one ladder's; the card must ignore them, or it would change when the
    // league switcher does.
    const view = await selectFrom({
      wins: 3,
      losses: 1,
      career: buildPlayerCareer({ decided: 35, wins: 24, losses: 11 }),
    })

    expect(view.record).toBe('24 W · 11 L')
    expect(view.record).not.toContain('3 W')
  })

  it('names the current streak, win or loss', async () => {
    const winning = await selectFrom({
      career: buildPlayerCareer({
        current_streak: buildPlayerStreak({ kind: 'W', n: 2 }),
      }),
    })
    expect(winning.streak).toEqual({ label: 'On a 2-win streak', tone: 'win' })

    const losing = await selectFrom({
      career: buildPlayerCareer({
        current_streak: buildPlayerStreak({ kind: 'L', n: 3 }),
      }),
    })
    expect(losing.streak).toEqual({ label: 'On a 3-loss streak', tone: 'loss' })
  })

  it('counts the best streak in matches, and pluralizes it', async () => {
    const seven = await selectFrom({
      career: buildPlayerCareer({
        best_streak: buildPlayerStreak({ kind: 'W', n: 7 }),
      }),
    })
    expect(tileValue(seven, 'Best streak')).toBe('7 wins')

    const one = await selectFrom({
      career: buildPlayerCareer({
        best_streak: buildPlayerStreak({ kind: 'W', n: 1 }),
      }),
    })
    expect(tileValue(one, 'Best streak')).toBe('1 win')
  })

  it('labels its total as DECIDED matches — not the match-history count beside it', async () => {
    // The Recent-matches card's link reads "View all 50 matches" off
    // `match_total`; this card counts only decided ones. The two numbers sit on
    // the same page and differ on purpose — the word "decided" is what stops a
    // reader reconciling them (ADR-0915).
    const view = await selectFrom({
      match_total: 50,
      career: buildPlayerCareer({ decided: 47, league_count: 2 }),
    })

    expect(view.total).toBe('47 decided · 2 leagues')
    expect(view.total).not.toContain('50')
  })

  it('says "1 league" when the player only plays in one', async () => {
    const view = await selectFrom({
      career: buildPlayerCareer({ decided: 35, league_count: 1 }),
    })

    expect(view.total).toBe('35 decided · 1 league')
  })

  it('reads the same cache entry as the profile bundle — no second request', () => {
    expect(careerCardQuery('p-1').queryKey).toEqual(
      playerByIdQueryOptions('p-1').queryKey,
    )
  })
})
