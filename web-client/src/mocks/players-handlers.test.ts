import { describe, expect, it } from 'vitest'

import type { components } from '@/api/schema'

import { mockPlayers, mockRecentOpponents } from './handlers'

type PlayerDetail = components['schemas']['PlayerDetail']
type PlayerSummary = components['schemas']['PlayerSummary']
type PlayerRead = components['schemas']['PlayerRead']

/**
 * The mock world's contract with the API it models.
 *
 * These tests do not exercise a component — they exercise **the mocks
 * themselves**, because the mocks are what regressed. A never-played player
 * reached production rendering a **1500** rating, a 1500 peak, a rank above real
 * players, a one-dot chart and a confidence card guessing they were "somewhere
 * between 814 and 2186" — and the whole test suite sailed over it, because MSW
 * handed that player a 1500 dressed up as a real rating. Every "Unrated" branch
 * the app grew was therefore unreachable in dev and untested in vitest: the model
 * agreed with the app instead of with the thing it modelled.
 *
 * So the shape of a never-played player is pinned here, at the boundary, against
 * the handlers the whole suite and `npm run dev` share. Reintroduce the seed
 * rating — or a fabricated record to go with it — and these red.
 *
 * The rule they encode, mirroring the API: **"unrated" means no rating-history
 * row other than the join seed** — you have never *completed a rated match*.
 * Joining a league seeds `rating_value = 1500` internally, but that seed is a
 * prior, not a played result, and it is not something the API ever sends.
 */

const neverPlayed = mockPlayers.find((p) => p.username === 'park.j')!
const rated = mockPlayers.find((p) => p.username === 'nguyen.t')!

async function getProfile(id: string): Promise<PlayerDetail> {
  const res = await fetch(`http://localhost/v1/players/${id}`)
  expect(res.ok).toBe(true)
  return (await res.json()) as PlayerDetail
}

async function getRoster(): Promise<PlayerSummary[]> {
  const res = await fetch('http://localhost/v1/players?page_size=25')
  const body = (await res.json()) as { items: PlayerSummary[] }
  return body.items
}

describe('the mock roster models the API’s unrated rule', () => {
  it('sends a never-played player NO rating — not the 1500 the league seeded', async () => {
    const bundle = await getProfile(neverPlayed.id)

    // The bug, in one line. A 1500 here is a seed masquerading as a result.
    expect(bundle.rating).toBeNull()
    expect(bundle.rating).not.toBe(1500)
  })

  it('gives them no standing either — a rating is what a rank, a peak and a percentile are made of', async () => {
    const bundle = await getProfile(neverPlayed.id)

    expect(bundle.rank).toBeNull()
    expect(bundle.rank_of).toBeNull()
    expect(bundle.percentile).toBeNull()
    // A peak of 1500 is the same lie as a rating of 1500: it is the seed again,
    // relabelled as the best they have ever been.
    expect(bundle.peak).toBeNull()
    expect(bundle.rating_delta).toBeNull()
  })

  it('gives them no confidence — there is nothing to be confident ABOUT', async () => {
    const bundle = await getProfile(neverPlayed.id)

    // "Somewhere between 814 and 2186" is what a confidence interval around a
    // rating that does not exist looks like. The API sends `null`; the card must
    // therefore have nothing to render.
    expect(bundle.confidence).toBeNull()
  })

  it('gives them an EMPTY rating window — no anchor, no points, no peak, no change', async () => {
    const bundle = await getProfile(neverPlayed.id)

    // Not a one-point window at the seed: they have no rating timeline at all,
    // and the chart draws them an Unrated panel instead of a lone dot at 1500.
    expect(bundle.rating_history).toEqual({
      anchor: null,
      points: [],
      peak: null,
      change: null,
    })
  })

  it('gives them a NULL rating on the ladder they joined — belonging is not a rating', async () => {
    const bundle = await getProfile(neverPlayed.id)

    expect(bundle.leagues.length).toBeGreaterThan(0)
    expect(bundle.leagues.map((league) => league.rating)).toEqual(
      bundle.leagues.map(() => null),
    )
    // The Leagues card and the Career card's "· N leagues" sit on the same page.
    expect(bundle.leagues).toHaveLength(bundle.career.league_count)
  })

  it('gives them an empty career and an empty match list — and the two AGREE', async () => {
    const bundle = await getProfile(neverPlayed.id)

    // The mock used to hash a career out of their username — 20 decided matches,
    // 13 wins, ten form dots — and then serve an empty match list underneath it.
    // A record with no matches to back it is the same class of lie as a rating
    // with no results to back it.
    expect(bundle.career.decided).toBe(0)
    expect(bundle.career.wins).toBe(0)
    expect(bundle.career.losses).toBe(0)
    // Null shares, not zeroes: a 0% would claim they lose every match they play.
    expect(bundle.career.win_rate).toBeNull()
    expect(bundle.career.games_won_pct).toBeNull()
    expect(bundle.career.current_streak).toBeNull()
    expect(bundle.career.best_streak).toBeNull()

    expect(bundle.wins).toBe(0)
    expect(bundle.losses).toBe(0)
    expect(bundle.form).toBe('')
    expect(bundle.match_total).toBe(0)
    expect(bundle.matches.items).toEqual([])
  })

  it('has them meet nobody — a meeting is a decided match', async () => {
    const bundle = await getProfile(neverPlayed.id)

    expect(bundle.head_to_head.frequent_opponents).toEqual([])
    // The block itself is still present, never `null`: the card renders its
    // "you haven't played them yet" invitation and its Start-a-match CTA off it.
    expect(bundle.head_to_head.versus_viewer).toMatchObject({
      wins: 0,
      losses: 0,
      meetings: 0,
      last_meeting: null,
    })
  })

  it('has no one else claim to have met them, either', async () => {
    const bundle = await getProfile(rated.id)

    expect(
      bundle.head_to_head.frequent_opponents.map((r) => r.opponent.username),
    ).not.toContain(neverPlayed.username)
  })

  it('still sends a RATED player a full standing — the fix must not unrate the ladder', async () => {
    const bundle = await getProfile(rated.id)

    expect(bundle.rating).toBe(1842)
    expect(bundle.rank).toBeGreaterThan(0)
    expect(bundle.rank_of).toBeGreaterThan(0)
    expect(bundle.peak).not.toBeNull()
    expect(bundle.confidence).not.toBeNull()
    expect(bundle.rating_history.points.length).toBeGreaterThan(0)
    expect(bundle.career.decided).toBeGreaterThan(0)
    expect(bundle.leagues.every((league) => league.rating !== null)).toBe(true)
  })
})

describe('the roster sorts an unrated player LAST, not into the middle of the ladder', () => {
  it('ranks them nowhere and puts them at the bottom', async () => {
    const items = await getRoster()

    const row = items.find((p) => p.username === neverPlayed.username)!
    expect(row.rating).toBeNull()
    // Seeded at 1500 they used to sort into the *middle* of the mock ladder,
    // above real players who had actually earned a rating below it.
    expect(items.at(-1)!.username).toBe(neverPlayed.username)
    expect(row.rank).toBeNull()
    // The dots column reads their form: no matches, no dots (the cell shows an
    // em-dash). Ten fabricated dots is what it printed before.
    expect(row.form).toBe('')
  })

  it('leaves the rated ladder ranked from the top', async () => {
    const items = await getRoster()

    const ratedRows = items.filter((p) => p.rating !== null)
    expect(ratedRows[0].rank).toBe(1)
    expect(ratedRows.map((p) => p.rank)).toEqual(
      ratedRows.map((_, i) => i + 1),
    )
  })
})

describe('the opponent picker', () => {
  it('keeps a player you have never played OUT of "recent opponents"', () => {
    // `list_recent_opponents` returns "only real opponents … so the picker never
    // presents strangers as recent opponents" (#167). Someone who has played
    // nobody has played *you* least of all.
    expect(mockRecentOpponents.map((p) => p.username)).not.toContain(
      neverPlayed.username,
    )
  })

  it('still finds them by SEARCH — with a null rating for the chip to degrade on', async () => {
    const res = await fetch('http://localhost/v1/players/search?q=park')
    const found = (await res.json()) as PlayerRead[]

    expect(found.map((p) => p.username)).toContain(neverPlayed.username)
    // The chip's secondary line reads "RATING 1500" off a number and
    // "REGISTERED PLAYER" off a null — so the null is the whole test.
    expect(found.find((p) => p.username === neverPlayed.username)!.rating).toBeNull()
  })
})
