import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatchesPage } from '../../test/pages/MatchesPage'
import { grantSession } from '../../test/server'
import * as sample from './browse/sampleMatches'
import type { MatchRecord } from './browse/sampleMatches'

vi.mock('./browse/sampleMatches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./browse/sampleMatches')>()
  return { ...actual, loadMatches: vi.fn(actual.loadMatches), loadMatch: vi.fn(actual.loadMatch) }
})

const loadMatches = vi.mocked(sample.loadMatches)
const loadMatch = vi.mocked(sample.loadMatch)
const realList = async () => sample.sampleMatches
const realMatch = async (id: string) => sample.sampleMatches.find((m) => m.id === id) ?? null

const live = 'Giulia Rossi vs Youssef Haddad'
const disputed = 'Thanh Nguyen vs Rashid Ali'
const disputedId = '0193f1a2-disp-0011'

function layout(narrow: boolean) {
  vi.stubGlobal('matchMedia', () => ({
    matches: narrow,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function hold<T>(mock: typeof loadMatches | typeof loadMatch) {
  let release: (value: T) => void = () => {}
  mock.mockImplementationOnce(() => new Promise<never>((resolve) => (release = resolve as (value: T) => void)))
  return (value: T) => act(async () => release(value))
}

beforeEach(() => {
  grantSession('matches.view')
  loadMatches.mockReset().mockImplementation(realList)
  loadMatch.mockReset().mockImplementation(realMatch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Matches', () => {
  it('shows a skeleton while the matches load, then every match newest first', async () => {
    const release = hold<readonly MatchRecord[]>(loadMatches)
    const page = await MatchesPage.render()

    expect(page.title).toHaveTextContent('Matches')
    expect(page.loading).toBeInTheDocument()
    expect(page.table).toBeNull()

    await release(sample.sampleMatches)

    expect(page.loading).toBeNull()
    expect(page.matchNames()).toHaveLength(sample.sampleMatches.length)
    expect(page.matchNames()[0]).toBe(live)
  })

  it('shows an error with Try again, and keeps the filters usable', async () => {
    loadMatches.mockRejectedValue(new Error('down'))
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.alert).toBeInTheDocument())
    await page.chip('Live')
    expect(page.alert).toBeInTheDocument()

    loadMatches.mockImplementation(realList)
    await page.tryAgain()

    await waitFor(() => expect(page.matchNames()).toEqual([live, 'Alex Rivera vs Wei Chen']))
  })

  it('narrows the list by state, and to your matches', async () => {
    const page = await MatchesPage.render()
    await waitFor(() => expect(page.matchNames()).toHaveLength(sample.sampleMatches.length))

    await page.chip('Waiting for sign-off')
    expect(page.matchNames()).toHaveLength(4)
    expect(page.matchNames()).toContain(disputed)

    await page.chip('Your matches')
    expect(page.matchNames()).not.toContain(disputed)
    expect(page.matchNames()).toHaveLength(2)

    await page.chip('All matches')
    expect(page.matchNames()).toHaveLength(sample.sampleMatches.length)
  })

  it('shows a table from 900px', async () => {
    layout(false)
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.table).toBeInTheDocument())
    expect(page.matchLink(disputed)).toHaveAttribute('href', `/matches/${disputedId}`)
  })

  it('shows match rows below 900px, each a link to its match', async () => {
    layout(true)
    const page = await MatchesPage.render()

    await waitFor(() => expect(page.matchNames()).toHaveLength(sample.sampleMatches.length))
    expect(page.table).toBeNull()
    expect(page.matchLink(disputed)).toHaveAttribute('href', `/matches/${disputedId}`)
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
    expect(loadMatch).not.toHaveBeenCalled()

    const link = page.matchLink(disputed)
    if (narrow) page.touch(link)
    else await page.hover(link)

    await waitFor(() => expect(loadMatch).toHaveBeenCalledWith(disputedId))
  })

  it.each([
    ['the sidebar, on hover', false],
    ['the tab bar, on touch', true],
  ] as const)('loads the matches from %s', async (_, narrow) => {
    layout(narrow)
    const page = await MatchesPage.render('/')
    expect(loadMatches).not.toHaveBeenCalled()

    const link = page.navLink('Matches')
    if (narrow) page.touch(link)
    else await page.hover(link)

    await waitFor(() => expect(loadMatches).toHaveBeenCalled())
  })

  it('loads the matches from the breadcrumb of a match', async () => {
    const page = await MatchesPage.render(`/matches/${disputedId}`)
    await waitFor(() => expect(page.title).toHaveTextContent(disputed))
    expect(loadMatches).not.toHaveBeenCalled()

    await page.hover(page.breadcrumb)

    await waitFor(() => expect(loadMatches).toHaveBeenCalled())
  })
})

describe('A match', () => {
  it('shows a skeleton while the match loads, then its sign-off', async () => {
    const release = hold<MatchRecord | null>(loadMatch)
    const page = await MatchesPage.render(`/matches/${disputedId}`)

    expect(page.loading).toBeInTheDocument()

    await release(await realMatch(disputedId))

    expect(page.loading).toBeNull()
    expect(page.title).toHaveTextContent(disputed)
    expect(page.text('The players signed different scores')).toBeInTheDocument()
  })

  it('shows an error with Try again, and keeps the breadcrumb working', async () => {
    loadMatch.mockRejectedValue(new Error('down'))
    const page = await MatchesPage.render(`/matches/${disputedId}`)

    await waitFor(() => expect(page.alert).toBeInTheDocument())
    expect(page.breadcrumb).toHaveAttribute('href', '/matches')

    loadMatch.mockImplementation(realMatch)
    await page.tryAgain()

    await waitFor(() => expect(page.title).toHaveTextContent(disputed))
  })

  it('says so when there is no such match', async () => {
    const page = await MatchesPage.render('/matches/nope')

    await waitFor(() => expect(page.title).toHaveTextContent('No such match'))
  })
})
