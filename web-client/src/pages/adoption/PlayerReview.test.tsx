import { act, fireEvent, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionQuery } from '../../api/queries'
import type { components } from '../../api/schema'
import { HomePage } from '../../test/pages/HomePage'
import { PlayerReviewPage, type ReviewAction } from '../../test/pages/PlayerReviewPage'
import {
  API_BASE_URL,
  failPlayersOnce,
  failSession,
  holdPlayers,
  listedPlayer,
  mockVerifiedAccount,
  server,
  STAND_IN,
} from '../../test/server'

const egret = listedPlayer({
  id: '7d1c2f0a-3b6e-4f8a-9c2d-1e5f6a7b8c90',
  display_name: 'excited egret 387',
  relationship: 'managed',
  open_question: true,
})
// The egret as the account's own player, as a sign-in with a new email
// leaves the guest's player that played.
const egretOwn = { ...egret, relationship: 'self' as const }
const badger = listedPlayer({
  id: '2a9b8c7d-6e5f-4a3b-8c1d-0e9f8a7b6c54',
  display_name: 'brave badger 214',
  relationship: 'managed',
  open_question: true,
})
// The player the API gives the account after sign-in. It is the newest.
const dove = listedPlayer({
  id: '9f8e7d6c-5b4a-4392-8a1b-0c9d8e7f6a5b',
  display_name: 'dreamy dove 412',
  relationship: 'self',
  open_question: false,
})
const ama = listedPlayer({
  id: '5e4d3c2b-1a09-4f8e-8d7c-6b5a4f3e2d10',
  display_name: 'Ama Mensah',
  relationship: 'self',
  open_question: false,
})

const heron = listedPlayer({
  id: '3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a98',
  display_name: 'happy heron 530',
  relationship: 'managed',
  open_question: true,
})

// A player the account already manages, older than the others.
const ant = listedPlayer({
  id: '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a81',
  display_name: 'able ant 102',
  relationship: 'managed',
  open_question: false,
})

// Another player the account already manages.
const owl = listedPlayer({
  id: '8a7b6c5d-4e3f-4a2b-9c1d-0e1f2a3b4c5d',
  display_name: 'outgoing owl 640',
  relationship: 'managed',
  open_question: false,
})

const NOT_SAVED = 'Your answer wasn’t saved. Please try again.'
const PLAYED_EACH_OTHER = 'These players played each other, so they are two people'

// `a` and `b` as the players list gives them once they played each other.
type AccountPlayer = components['schemas']['AccountPlayer']
type RecentMatch = components['schemas']['RecentMatch']
type RecentResult = components['schemas']['RecentResult']
function playedEachOther(a: AccountPlayer, b: AccountPlayer): [AccountPlayer, AccountPlayer] {
  return [
    { ...a, played_against: [...a.played_against, b.id] },
    { ...b, played_against: [...b.played_against, a.id] },
  ]
}

// Records each players request, and answers it with the egret.
function recordPlayersRequests(): Request[] {
  const requests: Request[] = []
  server.use(
    http.get(`${API_BASE_URL}/v1/account/players`, ({ request }) => {
      requests.push(request)
      return HttpResponse.json<components['schemas']['AccountPlayersResponse']>({ data: [egret] })
    }),
  )
  return requests
}

describe('Is this you?', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens right after sign-in and asks about the first player', async () => {
    mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render('/?signed_in=1')
    await page.findQuestion()

    expect(page.href).toBe('/review-players')
    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.heading).toHaveFocus()
    expect(page.text).toContain(`${egret.display_name} was used before you signed in.`)
    expect(page.answers).toHaveTextContent(
      `${egret.display_name} and ${dove.display_name} will become one player, your player.`,
    )
    expect(page.counter).toBeNull()
  })

  it('takes signed_in out of the URL when no player waits', async () => {
    mockVerifiedAccount([ama])
    const page = await PlayerReviewPage.render('/?signed_in=1')

    expect(page.href).toBe('/')
    expect(new HomePage(page.router).title).toHaveTextContent('What’s coming, and when.')
  })

  it('opens the review once a slow sign-in replaces the saved guest with the verified account', async () => {
    const requests = recordPlayersRequests()
    const page = await PlayerReviewPage.render('/?signed_in=1')
    expect(requests).toEqual([])

    mockVerifiedAccount([egret, dove])
    const { api, queryClient } = page.router.options.context
    await act(() => queryClient.refetchQueries({ queryKey: sessionQuery(api).queryKey }))
    await page.findQuestion()

    expect(page.href).toBe('/review-players')
    expect(page.heading).toHaveTextContent('Is this you?')
  })

  it('asks for no players on a visit to Home that doesn’t follow a sign-in', async () => {
    mockVerifiedAccount([egret, dove])
    const requests = recordPlayersRequests()
    const page = await PlayerReviewPage.render('/')

    expect(requests).toEqual([])
    expect(page.href).toBe('/')
    expect(new HomePage(page.router).title).toHaveTextContent('What’s coming, and when.')
  })

  it('offers only answers, with no way to leave without one', async () => {
    mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    expect(page.actions).toEqual(['Yes, this is me', 'Someone else played'])
    expect(page.text).not.toContain('Review later')
  })

  it.each([
    [['Yes, this is me'], 'yes', `${dove.display_name} merged into ${egret.display_name}, your player.`],
    [
      ['Someone else played', 'I manage this player'],
      'no',
      `${egret.display_name} added to players you manage.`,
    ],
    [
      ['Someone else played', 'Remove from my account'],
      'not_mine',
      `${egret.display_name} removed from your account.`,
    ],
  ] as const)('sends %j as %s, then goes Home with a toast', async (clicks, answer, toast) => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    for (const name of clicks) await page.click(name as ReviewAction)

    expect(api.answers).toEqual([{ playerId: egret.id, answer }])
    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([toast])
    expect(new HomePage(page.router).title).toHaveFocus()
  })

  it('confirms an answer on the page, and asks about the next player', async () => {
    const api = mockVerifiedAccount([egret, badger, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.counter).toBe('Player 2 of 2')
    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.heading).toHaveFocus()
    // The egret is older than the dove, so the dove merges into it.
    expect(page.notice).toBe(`${dove.display_name} merged into ${egret.display_name}, your player.`)
    expect(page.answers).toHaveTextContent(
      `${badger.display_name} and ${egret.display_name} will become one player, your player.`,
    )
    expect(page.toasts).toEqual([])

    await page.click('Someone else played')
    await page.click('I manage this player')

    expect(api.answers).toEqual([
      { playerId: egret.id, answer: 'yes' },
      { playerId: badger.id, answer: 'no' },
    ])
    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([`${badger.display_name} added to players you manage.`])
  })

  it('names the older player that "Yes" merged into, and the topbar shows it', async () => {
    const api = mockVerifiedAccount([ama, egret])
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.toasts).toEqual([`${egret.display_name} merged into Ama Mensah, your player.`])
    expect(new HomePage(page.router).avatar('Ama Mensah')).toHaveTextContent('AM')
  })

  it('shows the player in the topbar after "Yes"', async () => {
    mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    const home = new HomePage(page.router)
    expect(home.avatar(egret.display_name)).toHaveTextContent('EE')
    expect(home.avatar(dove.display_name)).toBeNull()
  })

  it('says the account’s own player stays its player, and "Yes" keeps it', async () => {
    const api = mockVerifiedAccount([ant, egretOwn])
    const page = await PlayerReviewPage.render()

    expect(page.answers).toHaveTextContent(`${egret.display_name} stays your player.`)
    expect(page.answers).not.toHaveTextContent('will become one player')

    await page.click('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.toasts).toEqual([`${egret.display_name} is your player now.`])
    expect(new HomePage(page.router).avatar(egret.display_name)).toHaveTextContent('EE')
  })

  it('asks about the account’s own player last, and "Yes" on another makes that one its player', async () => {
    const api = mockVerifiedAccount([egretOwn, badger])
    const page = await PlayerReviewPage.render()

    expect(page.text).toContain(`${badger.display_name} was used before you signed in.`)
    expect(page.answers).toHaveTextContent(
      `${badger.display_name} becomes your player. We’ll ask about ${egret.display_name} next.`,
    )
    expect(page.answers).not.toHaveTextContent('will become one player')

    await page.click('Yes, this is me')

    expect(page.notice).toBe(`${badger.display_name} is your player now.`)
    expect(page.text).toContain(`${egret.display_name} was used before you signed in.`)
    expect(page.answers).toHaveTextContent(
      `${egret.display_name} and ${badger.display_name} will become one player, your player.`,
    )

    await page.click('Someone else played')
    await page.click('I manage this player')

    expect(api.answers).toEqual([
      { playerId: badger.id, answer: 'yes' },
      { playerId: egret.id, answer: 'no' },
    ])
    expect(page.toasts).toEqual([`${egret.display_name} added to players you manage.`])
    const home = new HomePage(page.router)
    expect(home.avatar(badger.display_name)).toHaveTextContent('BB')
    expect(home.avatar(egret.display_name)).toBeNull()
  })

  it('keeps the account’s own player when another is one it manages, and "Yes" merges nothing', async () => {
    const api = mockVerifiedAccount([egretOwn, badger])
    const page = await PlayerReviewPage.render()
    await page.click('Someone else played')
    await page.click('I manage this player')

    expect(page.answers).toHaveTextContent(`${egret.display_name} stays your player.`)
    await page.click('Yes, this is me')

    expect(api.answers).toEqual([
      { playerId: badger.id, answer: 'no' },
      { playerId: egret.id, answer: 'yes' },
    ])
    expect(page.toasts).toEqual([`${egret.display_name} is your player now.`])
    expect(new HomePage(page.router).avatar(egret.display_name)).toHaveTextContent('EE')
  })

  it('shows the account’s new player in the topbar once its own player is one it manages, with no signal', async () => {
    mockVerifiedAccount([egretOwn])
    const page = await PlayerReviewPage.render()
    await page.click('Someone else played')
    failSession()

    await page.click('I manage this player')

    const home = new HomePage(page.router)
    expect(home.avatar(STAND_IN.display_name)).toHaveTextContent('CC')
    expect(home.avatar(egret.display_name)).toBeNull()
  })

  it.each<[string, ReviewAction[]]>([
    ['"Yes" comes back already answered', ['Yes, this is me']],
    ['Remove from my account gets a 409', ['Someone else played', 'Remove from my account']],
  ])(
    'shows the account’s new player in the topbar when another tab said No to its own player and %s',
    async (_, actions) => {
      const api = mockVerifiedAccount([egretOwn])
      const page = await PlayerReviewPage.render()
      api.answerInAnotherTab(egret.id, { answer: 'no' })

      for (const action of actions) await page.click(action)

      expect(page.toasts).toEqual([`${egret.display_name} was already answered in another tab.`])
      const home = new HomePage(page.router)
      expect(home.avatar(STAND_IN.display_name)).toHaveTextContent('CC')
      expect(home.avatar(egret.display_name)).toBeNull()
    },
  )

  it('asks whether the visitor manages the player, and goes back', async () => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Someone else played')

    expect(page.heading).toHaveTextContent('Do you manage this player?')
    expect(page.heading).toHaveFocus()
    expect(page.text).toContain(egret.display_name)
    expect(page.answers).toHaveTextContent('The player and their matches will stay in FortyMM.')

    await page.click('Back')

    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.heading).toHaveFocus()
    expect(api.answers).toEqual([])
  })

  it('says under the button that a failed answer wasn’t saved, and stays on the step', async () => {
    const api = mockVerifiedAccount([egret, dove], { failAnswers: true })
    const page = await PlayerReviewPage.render()
    await page.click('Someone else played')

    await page.click('Remove from my account')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'not_mine' }])
    expect(page.href).toBe('/review-players')
    expect(page.heading).toHaveTextContent('Do you manage this player?')
    expect(page.button('Remove from my account')).toHaveAccessibleDescription(NOT_SAVED)
    expect(page.button('I manage this player')).not.toHaveAccessibleDescription()
    expect(page.button('I manage this player')).toBeEnabled()
    expect(page.toasts).toEqual([])
  })

  it('says under "Yes, this is me" that a failed "Yes" wasn’t saved', async () => {
    const api = mockVerifiedAccount([egret, dove], { failAnswers: true })
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.href).toBe('/review-players')
    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.button('Yes, this is me')).toHaveAccessibleDescription(NOT_SAVED)
    expect(page.button('Yes, this is me')).toBeEnabled()
    expect(page.toasts).toEqual([])
  })

  it('sends one answer when "Yes" is clicked twice at once', async () => {
    const api = mockVerifiedAccount([egret, badger, dove])
    const page = await PlayerReviewPage.render()

    await page.clickTwiceAtOnce('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.notice).toBe(`${dove.display_name} merged into ${egret.display_name}, your player.`)
  })

  it('ignores the second click of a double click that lands on the next player', async () => {
    const api = mockVerifiedAccount([egret, badger, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')
    await page.clickAgainInDoubleClick('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.counter).toBe('Player 2 of 2')
  })

  it('ignores the second click of a double click on "Someone else played"', async () => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    await page.click('Someone else played')
    await page.clickAgainInDoubleClick('Remove from my account')

    expect(api.answers).toEqual([])
    expect(page.heading).toHaveTextContent('Do you manage this player?')
  })

  it('keeps an answered player gone when an older players request comes back after it', async () => {
    const api = mockVerifiedAccount([egret, badger, dove])
    const page = await PlayerReviewPage.render()
    // The first visit's players are a minute old, so the second visit
    // fetches them again.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)
    let release = () => {}
    // The review's refetch on entry reads the list from before the answer.
    server.use(
      http.get(
        `${API_BASE_URL}/v1/account/players`,
        async () => {
          await new Promise<void>((resolve) => (release = resolve))
          return HttpResponse.json<components['schemas']['AccountPlayersResponse']>({
            data: [egret, badger, dove],
          })
        },
        { once: true },
      ),
    )
    await page.reopen()

    await page.click('Yes, this is me')
    release()
    await page.settle()

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.counter).toBe('Player 2 of 2')
    expect(page.text).toContain(`${badger.display_name} was used before you signed in.`)
    expect(page.loadError('Can’t reach FortyMM')).toBeNull()
  })

  it('names the self player of the latest players list in what "Yes" does', async () => {
    mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    // Another tab merged the dove into Ama's older player.
    server.use(
      http.get(`${API_BASE_URL}/v1/account/players`, () =>
        HttpResponse.json<components['schemas']['AccountPlayersResponse']>({ data: [ama, egret] }),
      ),
    )

    await page.reopen()

    expect(page.answers).toHaveTextContent(
      `${egret.display_name} and ${ama.display_name} will become one player, your player.`,
    )
  })

  it.each([
    ['yes', ['Yes, this is me']],
    ['no', ['Someone else played', 'I manage this player']],
  ] as const)(
    'says another tab answered the player when it said %s, keeps the count, and asks about the next one',
    async (_answer, clicks) => {
      const api = mockVerifiedAccount([egret, badger, heron, dove])
      const page = await PlayerReviewPage.render()
      expect(page.counter).toBe('Player 1 of 3')
      api.answerInAnotherTab(egret.id, { answer: 'no' })
      api.answerInAnotherTab(badger.id, { answer: 'no' })

      for (const name of clicks) await page.click(name as ReviewAction)

      expect(page.notice).toBe(`${egret.display_name} was already answered in another tab.`)
      expect(page.counter).toBe('Player 3 of 3')
      expect(page.text).toContain(`${heron.display_name} was used before you signed in.`)
      expect(page.button('Yes, this is me')).not.toHaveAccessibleDescription()
    },
  )

  it('says nothing merged when another tab said No before this tab’s Yes', async () => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()
    api.answerInAnotherTab(egret.id, { answer: 'no' })

    await page.click('Yes, this is me')

    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([`${egret.display_name} was already answered in another tab.`])
    expect(new HomePage(page.router).avatar(dove.display_name)).toHaveTextContent('DD')
  })

  it('says nothing was added when another tab said Yes before this tab’s No', async () => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()
    api.answerInAnotherTab(egret.id, { answer: 'yes' })

    await page.click('Someone else played')
    await page.click('I manage this player')

    expect(api.answers.at(-1)).toEqual({ playerId: egret.id, answer: 'no' })
    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([`${egret.display_name} was already answered in another tab.`])
  })

  it('says another tab answered the player when Remove from my account gets a 409', async () => {
    const api = mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()
    api.answerInAnotherTab(egret.id, { answer: 'no' })

    await page.click('Someone else played')
    await page.click('Remove from my account')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'not_mine' }])
    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([`${egret.display_name} was already answered in another tab.`])
    expect(new HomePage(page.router).title).toHaveFocus()
  })

  it('goes Home with a toast when another tab merged the last player', async () => {
    const api = mockVerifiedAccount([ama, egret])
    const page = await PlayerReviewPage.render()
    // The egret merges into Ama's older player, so the API answers 404.
    api.answerInAnotherTab(egret.id, { answer: 'yes' })

    await page.click('Someone else played')
    await page.click('I manage this player')

    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([`${egret.display_name} was already answered in another tab.`])
    expect(new HomePage(page.router).title).toHaveFocus()
  })

  it('says a "Yes" made the player the account’s own when it had none', async () => {
    mockVerifiedAccount([egret, dove])
    server.use(
      http.post(`${API_BASE_URL}/v1/account/players/:playerId/answer`, () =>
        HttpResponse.json<components['schemas']['AnswerResponse']>({
          data: [{ ...egret, relationship: 'self', open_question: false }],
          meta: { outcome: 'self' },
        }),
      ),
    )
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    expect(page.toasts).toEqual([`${egret.display_name} is your player now.`])
    expect(new HomePage(page.router).avatar(egret.display_name)).toHaveTextContent('EE')
  })

  it('offers no "Yes" for a player who played the account’s own player', async () => {
    const [egretPlayedDove, dovePlayedEgret] = playedEachOther(egret, dove)
    mockVerifiedAccount([egretPlayedDove, dovePlayedEgret])
    const page = await PlayerReviewPage.render()

    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.queryButton('Yes, this is me')).toBeNull()
    expect(page.answers).toHaveTextContent(
      `${egret.display_name} played ${dove.display_name}, your player, so it isn’t you.`,
    )
    expect(page.button('Someone else played')).toBeEnabled()
  })

  it('says why a "Yes" was refused when another tab made an opponent the account’s own', async () => {
    const [egretPlayedBadger, badgerPlayedEgret] = playedEachOther(egret, badger)
    // The badger is older than the dove, so a "Yes" for it makes it the
    // account's own player.
    const api = mockVerifiedAccount([egretPlayedBadger, badgerPlayedEgret, dove])
    const page = await PlayerReviewPage.render()
    api.answerInAnotherTab(badger.id, { answer: 'yes' })

    await page.click('Yes, this is me')

    expect(api.answers).toEqual([{ playerId: egret.id, answer: 'yes' }])
    expect(page.heading).toHaveTextContent('Is this you?')
    expect(page.notice).toBe(PLAYED_EACH_OTHER)
    expect(page.queryButton('Yes, this is me')).toBeNull()
    expect(page.answers).toHaveTextContent(
      `${egret.display_name} played ${badger.display_name}, your player, so it isn’t you.`,
    )
    expect(page.toasts).toEqual([])
  })

  describe('the match preview', () => {
    // Noon, so every match below was today.
    const NOW = new Date(2026, 10, 5, 12)
    const TODAY = /^Today · /

    function played(
      minutesAgo: number,
      opponents: string[],
      result?: RecentResult,
    ): RecentMatch {
      return {
        id: crypto.randomUUID(),
        played_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
        opponents,
        ...(result && { result }),
      }
    }

    function withMatches(recent: RecentMatch[], count = recent.length): AccountPlayer {
      return { ...egret, match_count: count, recent_matches: recent }
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('shows a match with no result', async () => {
      mockVerifiedAccount([withMatches([played(30, ['Sam'])]), dove])
      const page = await PlayerReviewPage.render()

      expect(page.matchPreview).toHaveTextContent('1 match today, against Sam')
      expect(page.previewMatches).toEqual([['Sam', 'No result', expect.stringMatching(TODAY)]])
      expect(page.matchPreview).not.toHaveTextContent('earlier')
    })

    it("sums up today's matches and shows each one's score", async () => {
      mockVerifiedAccount([
        withMatches([
          played(10, ['Sam'], { won: true, games: [3, 1] }),
          played(40, ['Kofi'], { won: false, games: [1, 3] }),
          played(70, ['Sam']),
        ]),
        dove,
      ])
      const page = await PlayerReviewPage.render()

      expect(page.matchPreview).toHaveTextContent('3 matches today, last one against Sam')
      expect(page.previewMatches).toEqual([
        ['Sam', 'Won 3–1', expect.stringMatching(TODAY)],
        ['Kofi', 'Lost 1–3', expect.stringMatching(TODAY)],
        ['Sam', 'No result', expect.stringMatching(TODAY)],
      ])
    })

    it('counts the matches it doesn’t list', async () => {
      const recent = [1, 2, 3, 4, 5].map((n) => played(n * 10, ['Sam']))
      mockVerifiedAccount([withMatches(recent, 7), dove])
      const page = await PlayerReviewPage.render()

      expect(page.matchPreview).toHaveTextContent('7 matches, last one today against Sam')
      expect(page.previewMatches).toHaveLength(5)
      expect(page.matchPreview).toHaveTextContent('2 earlier matches')
    })

    it('names a match with no opponent another player', async () => {
      mockVerifiedAccount([withMatches([played(30, [])]), dove])
      const page = await PlayerReviewPage.render()

      expect(page.matchPreview).toHaveTextContent('1 match today, against another player')
      expect(page.previewMatches).toEqual([['Another player', 'No result', expect.stringMatching(TODAY)]])
    })

    it('joins the players of a side', async () => {
      mockVerifiedAccount([withMatches([played(30, ['Kofi', 'Sam'])]), dove])
      const page = await PlayerReviewPage.render()

      expect(page.matchPreview).toHaveTextContent('1 match today, against Kofi & Sam')
    })

    it('gives the year of a match from another year', async () => {
      const lastYear = new Date(2025, 11, 20, 18)
      const minutesAgo = (NOW.getTime() - lastYear.getTime()) / 60_000
      mockVerifiedAccount([withMatches([played(minutesAgo, ['Sam'])]), dove])
      const page = await PlayerReviewPage.render()

      expect(page.matchPreview).toHaveTextContent(/^1 match on .*2025, against Sam/)
      expect(page.previewMatches).toEqual([['Sam', 'No result', expect.stringMatching(/2025 · /)]])
    })
  })

  it('shows an empty match preview, with no way to see all matches', async () => {
    mockVerifiedAccount([egret, dove])
    const page = await PlayerReviewPage.render()

    expect(page.matchPreview).toHaveTextContent('No matches yet')
    expect(within(page.matchPreview).queryByRole('button')).toBeNull()
    expect(within(page.matchPreview).queryByRole('link')).toBeNull()
  })

  describe('Which player?', () => {
    async function choosing(players: Parameters<typeof mockVerifiedAccount>[0], options = {}) {
      const api = mockVerifiedAccount(players, options)
      const page = await PlayerReviewPage.render()
      await page.click('Someone else played')
      await page.click('I manage this player')
      return { api, page }
    }

    it('offers the players the account manages', async () => {
      const { api, page } = await choosing([ant, egret, badger, dove])

      expect(api.answers).toEqual([])
      expect(page.heading).toHaveTextContent('Which player?')
      expect(page.heading).toHaveFocus()
      expect(page.text).toContain(`Matches from ${egret.display_name}`)
      expect(page.text).toContain('Choose a player to add these matches to.')
      // The badger's question is open and the dove is the account's own, so
      // neither is offered.
      expect(page.targets).toEqual([ant.display_name])
      expect(page.button('Keep as a separate player')).toBeEnabled()
    })

    it.each([
      [[ant, egret, dove], `${egret.display_name} merged into ${ant.display_name}.`],
      [[egret, ant, dove], `${ant.display_name} merged into ${egret.display_name}.`],
    ])('merges the player into the one chosen, and the older survives', async (players, toast) => {
      const { api, page } = await choosing(players)

      await page.choose(ant.display_name)

      expect(api.answers).toEqual([{ playerId: egret.id, answer: 'same_as', player_id: ant.id }])
      expect(page.href).toBe('/')
      expect(page.toasts).toEqual([toast])
      expect(new HomePage(page.router).avatar(dove.display_name)).toHaveTextContent('DD')
    })

    it('leaves out the players the player played', async () => {
      const [antPlayedEgret, egretPlayedAnt] = playedEachOther(ant, egret)
      const { page } = await choosing([antPlayedEgret, owl, egretPlayedAnt, dove])

      expect(page.targets).toEqual([owl.display_name])
    })

    it('says why a merge was refused when the chosen player played the player', async () => {
      const [antPlayedEgret, egretPlayedAnt] = playedEachOther(ant, egret)
      const { api, page } = await choosing([ant, owl, egret, dove])
      api.playersChange([antPlayedEgret, owl, egretPlayedAnt, dove])

      await page.choose(ant.display_name)

      expect(api.answers).toEqual([{ playerId: egret.id, answer: 'same_as', player_id: ant.id }])
      expect(page.heading).toHaveTextContent('Which player?')
      expect(page.notice).toBe(PLAYED_EACH_OTHER)
      expect(page.targets).toEqual([owl.display_name])
      expect(page.toasts).toEqual([])
    })

    it('keeps the player as a separate one', async () => {
      const { api, page } = await choosing([ant, egret, dove])

      await page.click('Keep as a separate player')

      expect(api.answers).toEqual([{ playerId: egret.id, answer: 'no' }])
      expect(page.toasts).toEqual([`${egret.display_name} added to players you manage.`])
    })

    it('goes back to "Do you manage this player?"', async () => {
      const { api, page } = await choosing([ant, egret, dove])

      await page.click('Back')

      expect(api.answers).toEqual([])
      expect(page.heading).toHaveTextContent('Do you manage this player?')
      expect(page.heading).toHaveFocus()
    })

    it('says under the player that a failed merge wasn’t saved', async () => {
      const { api, page } = await choosing([ant, egret, dove], { failAnswers: true })

      await page.choose(ant.display_name)

      expect(api.answers).toEqual([{ playerId: egret.id, answer: 'same_as', player_id: ant.id }])
      expect(page.heading).toHaveTextContent('Which player?')
      expect(page.target(ant.display_name)).toHaveAccessibleDescription(NOT_SAVED)
      expect(page.target(ant.display_name)).toBeEnabled()
      expect(page.button('Keep as a separate player')).not.toHaveAccessibleDescription()
      expect(page.toasts).toEqual([])
    })

    it('says so when another tab merged the chosen player away', async () => {
      const { api, page } = await choosing([badger, egret, ant, dove])
      // The egret is older, so the ant merges into it and leaves the list.
      api.answerInAnotherTab(egret.id, { answer: 'same_as', player_id: ant.id })

      await page.choose(ant.display_name)

      expect(page.heading).toHaveTextContent('Which player?')
      expect(page.notice).toBe(`${ant.display_name} isn’t one of your players any more.`)
      expect(page.targets).toEqual([egret.display_name])
      expect(page.toasts).toEqual([])
    })

    it('sends one answer when a player is clicked twice at once', async () => {
      const { api, page } = await choosing([ant, egret, badger, dove])

      const target = page.target(ant.display_name)
      fireEvent.click(target)
      fireEvent.click(target)
      await page.settle()

      expect(api.answers).toEqual([{ playerId: egret.id, answer: 'same_as', player_id: ant.id }])
      expect(page.notice).toBe(`${egret.display_name} merged into ${ant.display_name}.`)
    })
  })

  it('shows Saving… while an answer saves, and holds the other actions', async () => {
    mockVerifiedAccount([egret, dove])
    let release = () => {}
    // Returns nothing once released, so mockVerifiedAccount's handler answers.
    server.use(
      http.post(`${API_BASE_URL}/v1/account/players/:playerId/answer`, async () => {
        await new Promise<void>((resolve) => (release = resolve))
      }),
    )
    const page = await PlayerReviewPage.render()

    await page.click('Yes, this is me')

    const saving = within(page.answers).getByRole('button', { name: 'Saving…' })
    expect(saving).toHaveAttribute('aria-busy', 'true')
    expect(page.button('Someone else played')).toBeDisabled()

    release()
    await page.settle()

    expect(page.href).toBe('/')
    expect(page.toasts).toEqual([`${dove.display_name} merged into ${egret.display_name}, your player.`])
  })

  it('leaves for Home when no player waits, and Home’s title takes focus', async () => {
    mockVerifiedAccount([ama])
    const page = await PlayerReviewPage.render()

    expect(page.href).toBe('/')
    expect(new HomePage(page.router).title).toHaveFocus()
  })

  it('asks a guest for no players, and leaves for Home', async () => {
    const requests = recordPlayersRequests()
    const page = await PlayerReviewPage.render()

    expect(requests).toEqual([])
    expect(page.href).toBe('/')
  })

  it('shows a skeleton while the players load, then the question', async () => {
    mockVerifiedAccount([egret, dove])
    const players = holdPlayers()
    const page = await PlayerReviewPage.render()

    expect(page.loading).toBe(true)
    expect(page.wordmark).toBeVisible()
    expect(page.queryHeading).toBeNull()

    await players.release()
    await page.findQuestion()

    expect(page.loading).toBe(false)
    expect(page.heading).toHaveTextContent('Is this you?')
  })

  it('says the players didn’t load, and Try again asks again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockVerifiedAccount([egret, dove])
    failPlayersOnce(500)
    const page = await PlayerReviewPage.render()

    const alert = page.loadError('Something went wrong')
    expect(alert).not.toBeNull()
    expect(within(alert!).getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '/')

    await page.tryAgain(alert!)
    await page.findQuestion()

    expect(page.loadError('Something went wrong')).toBeNull()
    expect(page.heading).toHaveTextContent('Is this you?')
  })

  it('keeps Home working when the players after a sign-in can’t load, and Try again opens the review', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockVerifiedAccount([egret, dove])
    failPlayersOnce(500)
    const page = await PlayerReviewPage.render('/?signed_in=1')

    const alert = page.loadError('Something went wrong')
    expect(alert).not.toBeNull()
    expect(new HomePage(page.router).title).toHaveTextContent('What’s coming, and when.')

    await page.tryAgain(alert!)
    await page.findQuestion()

    expect(page.href).toBe('/review-players')
    expect(page.heading).toHaveTextContent('Is this you?')
  })
})
