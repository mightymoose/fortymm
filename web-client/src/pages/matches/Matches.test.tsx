import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '../../api/schema'
import { MatchesPage } from '../../test/pages/MatchesPage'
import { grantSession, mockMatchReads } from '../../test/server'

type MatchDetail = components['schemas']['MatchDetail']
type MatchEvent = components['schemas']['MatchEvent']

let ids = 0
const ALEX = 'Alex Rivera'

// A match between `names`, side 0 first, with `fields` over a best of 5
// rated match nobody has scored. `you` is the viewer's side.
function match(
  names: [string, string],
  fields: Partial<MatchDetail> & { you?: 0 | 1 } = {},
): MatchDetail {
  const { you = null, ...rest } = fields
  const id = `0193f1a2-0000-7000-8000-${String(++ids).padStart(12, '0')}`
  return {
    id,
    best_of: 5,
    rated: true,
    started_at: '2026-11-05T19:00:00Z',
    sides: names.map((name, side) => ({
      side: side as 0 | 1,
      players: [{ id: `${id.slice(0, -2)}${side}${side}`, display_name: name }],
    })),
    viewer_side: you,
    games: [],
    retired_by: null,
    state: { kind: 'not_started' },
    history: [],
    ...rest,
  }
}

const event = (kind: MatchEvent['kind'], by: string, fields: Partial<MatchEvent> = {}): MatchEvent => ({
  at: '2026-11-05T19:00:00Z',
  kind,
  by,
  side: null,
  games: kind === 'created' ? null : [],
  ...fields,
})

const live = match(['Giulia Rossi', 'Youssef Haddad'], {
  games: [[4, 11], [9, 8]],
  state: { kind: 'live' },
})
const betweenGames = match(['Giulia Rossi', 'Youssef Haddad'], {
  games: [[11, 4], [11, 9]],
  state: { kind: 'live' },
})
const midGame = match(['Giulia Rossi', 'Youssef Haddad'], {
  games: [[11, 4], [6, 4]],
  state: { kind: 'live' },
})
const notStarted = match([ALEX, 'Wei Chen'], { you: 0 })
const awaiting = match(['Meera Okafor', ALEX], {
  you: 1,
  games: [[11, 6], [8, 11], [11, 9]],
  state: { kind: 'awaiting', signed_by: 0, signed_at: '2026-11-05T18:41:00Z' },
})
const disputed = match(['Thanh Nguyen', 'Rashid Ali'], {
  best_of: 3,
  games: [[11, 9], [7, 11], [9, 11]],
  state: {
    kind: 'disputed',
    signed_by: 1,
    signed_at: '2026-11-03T19:40:00Z',
    their_games: [[11, 9], [11, 7]],
  },
  history: [
    event('created', 'Rashid Ali'),
    event('board', 'Thanh Nguyen', { games: [[11, 9], [11, 7]] }),
    event('signed', 'Thanh Nguyen', { side: 0, games: [[11, 9], [11, 7]] }),
    event('signed', 'Rashid Ali', { side: 1, games: [[11, 9], [7, 11], [9, 11]] }),
  ],
})
const approved = match([ALEX, 'Annika Johansen-Whitfield'], {
  you: 0,
  games: [[11, 9], [8, 11], [11, 6], [11, 4]],
  state: { kind: 'final', accepted_at: '2026-11-04T19:44:00Z', approved_by: [0, 1], override_reason: null },
  history: [
    event('created', ALEX),
    event('signed', ALEX, { side: 0, games: [[11, 9], [8, 11], [11, 6], [11, 4]] }),
    event('approved', 'Annika Johansen-Whitfield', { side: 1, games: [[11, 9], [8, 11], [11, 6], [11, 4]] }),
  ],
})
const reported = match(['Ji-ho Park', 'Marisol Fernández-Castillo'], {
  rated: false,
  games: [[11, 13], [11, 9], [8, 11], [11, 6], [9, 11]],
  state: { kind: 'final', accepted_at: '2026-11-04T17:02:00Z', approved_by: [1], override_reason: null },
})
const overridden = match(['Erik Lindqvist', 'Camille Dubois'], {
  games: [[11, 7], [11, 5], [9, 11], [11, 8]],
  state: {
    kind: 'final',
    accepted_at: '2026-11-03T18:22:00Z',
    approved_by: [],
    override_reason: 'The scorer swapped game 2',
  },
  history: [
    event('created', 'Erik Lindqvist'),
    event('board', 'Camille Dubois', { games: [] }),
    event('override', 'Sam Referee', { games: [[11, 7], [11, 5], [9, 11], [11, 8]] }),
  ],
})
const retired = match(['Wei Chen', 'Meera Okafor'], {
  games: [[8, 11], [11, 9], [2, 5]],
  retired_by: 1,
  state: { kind: 'final', accepted_at: '2026-11-02T18:39:00Z', approved_by: [0, 1], override_reason: null },
})

const everyMatch = [live, notStarted, awaiting, disputed, approved, reported, overridden, retired]
const name = (m: MatchDetail) => `${m.sides[0].players[0].display_name} vs ${m.sides[1].players[0].display_name}`

function layout(narrow: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches: narrow,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

let api: ReturnType<typeof mockMatchReads>

beforeEach(() => {
  grantSession('matches.view')
  api = mockMatchReads(everyMatch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Matches', () => {
  it('shows a skeleton while the matches load, then every match newest first', async () => {
    api.hold = true
    const page = await MatchesPage.render()

    expect(page.title).toHaveTextContent('Matches')
    expect(page.loading).toBeInTheDocument()
    expect(page.table).toBeNull()

    await api.release()

    await waitFor(() => expect(page.loading).toBeNull())
    expect(page.matchNames()).toEqual(everyMatch.map(name))
  })

  it('shows an error with Try again, and keeps the filters usable', async () => {
    api.fails = true
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.alert).toBeInTheDocument())
    await page.chip('Live')
    expect(page.alert).toBeInTheDocument()

    api.fails = false
    await page.tryAgain()

    await waitFor(() => expect(page.matchNames()).toEqual([name(live), name(notStarted)]))
  })

  it('narrows the list by state, and to your matches', async () => {
    const page = await MatchesPage.render()
    await waitFor(() => expect(page.matchNames()).toHaveLength(everyMatch.length))

    await page.chip('Waiting for sign-off')
    expect(page.matchNames()).toEqual([name(awaiting), name(disputed)])

    await page.chip('Your matches')
    expect(page.matchNames()).toEqual([name(awaiting)])

    await page.chip('All matches')
    expect(page.matchNames()).toHaveLength(everyMatch.length)
  })

  it('counts a match nobody has scored as live, and says it hasn’t started', async () => {
    layout(false)
    const page = await MatchesPage.render()
    await waitFor(() => expect(page.table).toBeInTheDocument())

    await page.chip('Live')

    expect(page.matchNames()).toEqual([name(live), name(notStarted)])
    expect(page.text('Not started')).toBeInTheDocument()
  })

  it('says so when a filter leaves no match, and shows no table', async () => {
    layout(false)
    api = mockMatchReads([live, awaiting])
    const page = await MatchesPage.render()
    await waitFor(() => expect(page.table).toBeInTheDocument())

    await page.chip('Final')

    expect(page.text('No matches here')).toBeInTheDocument()
    expect(page.text('Turn off a filter to see more matches.')).toBeInTheDocument()
    expect(page.table).toBeNull()
  })

  it('says there are no matches yet, and shows no table', async () => {
    layout(false)
    api = mockMatchReads([])
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.text('No matches yet')).toBeInTheDocument())
    expect(page.text('Matches show here once someone starts one.')).toBeInTheDocument()
    expect(page.table).toBeNull()
    expect(page.matchNames()).toEqual([])
  })

  it('links New match from the empty list for an account that can start one', async () => {
    layout(false)
    grantSession('matches.view', 'matches.create')
    api = mockMatchReads([])
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.text('No matches yet')).toBeInTheDocument())
    expect(page.text('Start one with New match, and it shows here.')).toBeInTheDocument()
    expect(page.link('New match')).toHaveAttribute('href', '/matches/new')
  })

  it('says it shows only the 50 newest when more exist', async () => {
    api = mockMatchReads([live], { hasMore: true })
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.text('Showing the 50 newest matches.')).toBeInTheDocument())
  })

  it('says nothing of a limit when every match is listed', async () => {
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.matchNames()).toHaveLength(everyMatch.length))
    expect(page.text('Showing the 50 newest matches.')).toBeNull()
  })

  it('counts the last game of a live match as won once it reached a final score', async () => {
    layout(true)
    api = mockMatchReads([betweenGames])
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.matchNames()).toEqual([name(betweenGames)]))
    expect(page.rowScores(name(betweenGames))).toEqual(['2 games won', '0 games won'])
    expect(page.text('Points')).toBeNull()
  })

  it('shows the points of the game in play of a live match', async () => {
    layout(true)
    api = mockMatchReads([midGame])
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.matchNames()).toEqual([name(midGame)]))
    expect(page.rowScores(name(midGame))).toEqual([
      '1 games won',
      '6 points in this game',
      '0 games won',
      '4 points in this game',
    ])
  })

  it('shows a table from 900px', async () => {
    layout(false)
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.table).toBeInTheDocument())
    expect(page.matchLink(name(disputed))).toHaveAttribute('href', `/matches/${disputed.id}`)
  })

  it('shows match rows below 900px, each a link to its match', async () => {
    layout(true)
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.matchNames()).toHaveLength(everyMatch.length))
    expect(page.table).toBeNull()
    expect(page.matchLink(name(disputed))).toHaveAttribute('href', `/matches/${disputed.id}`)
  })
})

describe('Preloading', () => {
  it.each([
    ['from 900px, on hover', false],
    ['below 900px, on touch', true],
  ] as const)('loads a match %s of its link', async (_, narrow) => {
    layout(narrow)
    const page = await MatchesPage.render()
    await waitFor(() => expect(page.matchNames()).not.toHaveLength(0))
    expect(api.reads).toEqual([])

    const link = page.matchLink(name(disputed))
    if (narrow) page.touch(link)
    else await page.hover(link)

    await waitFor(() => expect(api.reads).toEqual([disputed.id]))
  })

  it.each([
    ['the sidebar, on hover', false],
    ['the tab bar, on touch', true],
  ] as const)('loads the matches from %s', async (_, narrow) => {
    layout(narrow)
    const page = await MatchesPage.render('/')
    expect(api.lists).toBe(0)

    const link = page.navLink('Matches')
    if (narrow) page.touch(link)
    else await page.hover(link)

    await waitFor(() => expect(api.lists).toBe(1))
  })

  it('loads the matches from the breadcrumb of a match', async () => {
    const page = await MatchesPage.render(`/matches/${disputed.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(disputed)))
    expect(api.lists).toBe(0)

    await page.hover(page.breadcrumb)

    await waitFor(() => expect(api.lists).toBe(1))
  })
})

describe('A match', () => {
  it('shows a skeleton while the match loads, then its sign-off', async () => {
    api.hold = true
    const page = await MatchesPage.render(`/matches/${disputed.id}`)

    expect(page.loading).toBeInTheDocument()

    await api.release()

    await waitFor(() => expect(page.loading).toBeNull())
    expect(page.title).toHaveTextContent(name(disputed))
    expect(page.text('The players signed different scores')).toBeInTheDocument()
  })

  it('shows an error with Try again, and keeps the breadcrumb working', async () => {
    api.fails = true
    const page = await MatchesPage.render(`/matches/${disputed.id}`)

    await waitFor(() => expect(page.alert).toBeInTheDocument())
    expect(page.breadcrumb).toHaveAttribute('href', '/matches')

    api.fails = false
    await page.tryAgain()

    await waitFor(() => expect(page.title).toHaveTextContent(name(disputed)))
  })

  it('says so when no match has the id', async () => {
    const missing = '0193f1a2-0000-7000-8000-999999999999'
    const page = await MatchesPage.render(`/matches/${missing}`)

    await waitFor(() => expect(page.title).toHaveTextContent('No such match'))
    expect(api.reads).toEqual([missing])
  })

  it('says so for an id that isn’t a match id, without asking the API', async () => {
    const page = await MatchesPage.render('/matches/nope')

    await waitFor(() => expect(page.title).toHaveTextContent('No such match'))
    expect(api.reads).toEqual([])
  })

  it('tells the story of a disputed match from its history', async () => {
    const page = await MatchesPage.render(`/matches/${disputed.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(disputed)))

    expect(page.history()).toEqual([
      'Rashid Ali started the match',
      'Thanh Nguyen saved game 2, 11–7',
      'Thanh Nguyen signed the result, 2–0',
      'Rashid Ali signed different scores, 1–2',
    ])
  })

  it('says a match nobody has scored has no scores yet, and offers Keep score', async () => {
    const page = await MatchesPage.render(`/matches/${notStarted.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(notStarted)))

    expect(page.text('Not started')).toBeInTheDocument()
    expect(page.text('No scores yet.')).toBeInTheDocument()
    expect(page.button('Keep score')).toBeInTheDocument()
    expect(page.signatures()).toEqual(['Signs when the match ends', 'Signs when the match ends'])
  })

  it('says both players approved a final result', async () => {
    const page = await MatchesPage.render(`/matches/${approved.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(approved)))

    expect(page.text(/^Both players approved this result on /)).toBeInTheDocument()
    expect(page.signatures()).toEqual(['Approved', 'Approved'])
    expect(page.history()).toEqual([
      'Alex Rivera started the match',
      'Alex Rivera signed the result, 3–1',
      'Annika Johansen-Whitfield approved the result',
    ])
  })

  it('says who reported a result only one player approved', async () => {
    const page = await MatchesPage.render(`/matches/${reported.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(reported)))

    expect(page.text(/^Marisol Fernández-Castillo reported this result on /)).toBeInTheDocument()
    expect(page.signatures()).toEqual(['Hasn’t approved', 'Approved'])
  })

  it('says an administrator set a result, and why', async () => {
    const page = await MatchesPage.render(`/matches/${overridden.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(overridden)))

    expect(
      page.text(/^An administrator set this result on .+\. They wrote: “The scorer swapped game 2”$/),
    ).toBeInTheDocument()
    expect(page.signatures()).toEqual(['Set by an administrator', 'Set by an administrator'])
    expect(page.history()).toEqual([
      'Erik Lindqvist started the match',
      'Camille Dubois started keeping score',
      'Sam Referee set the result, 3–1',
    ])
  })

  it('says who won the last game of a live match once it reached a final score', async () => {
    api = mockMatchReads([betweenGames])
    const page = await MatchesPage.render(`/matches/${betweenGames.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(betweenGames)))

    expect(page.games()).toEqual(['Game 1 11–4 Giulia Rossi won', 'Game 2 11–9 Giulia Rossi won'])
    expect(page.text('2–0')).toBeInTheDocument()
  })

  it('shows the unfinished last game of a live match as in play', async () => {
    api = mockMatchReads([midGame])
    const page = await MatchesPage.render(`/matches/${midGame.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(midGame)))

    expect(page.games()).toEqual(['Game 1 11–4 Giulia Rossi won', 'Game 2 6–4 Live'])
    expect(page.text('1–0')).toBeInTheDocument()
  })

  it('says who retired, and that their last game didn’t finish', async () => {
    const page = await MatchesPage.render(`/matches/${retired.id}`)
    await waitFor(() => expect(page.title).toHaveTextContent(name(retired)))

    expect(page.text('Meera Okafor retired.')).toBeInTheDocument()
    expect(page.text('Not finished')).toBeInTheDocument()
  })
})
