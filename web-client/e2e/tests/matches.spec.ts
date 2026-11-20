import type { Page } from '@playwright/test'
import { expect, test } from '../pages/test.ts'
import {
  App,
  AppLayout,
  MatchDetailsPage,
  MatchesPage,
  NewMatchPage,
  NotFoundPage,
  ScoringPage,
  scoredMatchId,
} from '../pages/app.ts'
import { blockedSiteData } from '../pages/blocked-site-data.ts'
import { StorageHarness } from '../pages/storage.ts'

// The app's match stores on the device (src/stores/match-device.ts): what a
// person starts on the form and scores on a match's pages is kept as signed
// records in IndexedDB, so it is there after a reload, with no connection
// and in another tab. Driven through the app's own pages; the storage
// harness page (/storage.html, in the "harness" deployment, which is the app
// with test-only pages) looks at what is kept, or holds the append lock. The
// stores' logic over a source is in src/stores/*.test.ts, on memory.

test.use({ build: 'harness' })

// Starts a match of `bestOf` on the form, and gives its id once Start match
// has opened game 1's scoring page.
async function startMatch(page: Page, bestOf: number): Promise<string> {
  const newMatch = new NewMatchPage(page)
  await newMatch.goto()
  await newMatch.bestOf(bestOf).click()
  await newMatch.startMatch.click()
  return scoredMatchId(page)
}

// Saves `score` as game `game` on its scoring page, and waits until the
// save has moved on to the next game's page, or to the dashboard.
async function saveGame(page: Page, matchId: string, game: number, score: [number, number]) {
  const scoring = new ScoringPage(page)
  await scoring.goto(matchId, game)
  await scoring.enter(score)
  await scoring.save.click()
  await expect(page).not.toHaveURL(new RegExp(`/games/${game}/scores/edit$`))
}

// The score records kept for a match, from the journal.
async function scoreRecords(harness: StorageHarness, matchId: string) {
  const journal = (await harness.readStore('journal')) as [number, { kind: string; match: string | null }][]
  return journal.filter(([, row]) => row.kind === 'score' && row.match === matchId)
}

test('G2.1: a match started on the form is listed after a reload, and opens as chosen, against Anonymous, unrated', async ({
  page,
}) => {
  const matchId = await startMatch(page, 5)

  const matches = new MatchesPage(page)
  await matches.goto()
  await expect(matches.rows).toHaveCount(1)
  await expect(matches.rows.getByRole('link')).toHaveAttribute('href', `/matches/${matchId}`)

  const details = new MatchDetailsPage(page)
  await details.goto(matchId)
  await expect(details.heading).toHaveText('You vs Anonymous')
  await expect(details.format).toHaveText('Best of 5 · Unrated · Game 1 next')
  await expect(details.noGames).toBeVisible()
})

test('the list shows this device’s matches newest first', async ({ page }) => {
  const first = await startMatch(page, 3)
  const second = await startMatch(page, 5)

  const matches = new MatchesPage(page)
  await matches.goto()
  await expect(matches.rows).toHaveCount(2)
  await expect(matches.rows.nth(0).getByRole('link')).toHaveAttribute('href', `/matches/${second}`)
  await expect(matches.rows.nth(1).getByRole('link')).toHaveAttribute('href', `/matches/${first}`)
})

test('an address whose id is no match kept here is not found, on the match’s page and a game’s', async ({
  page,
}) => {
  const matchId = await startMatch(page, 3)
  const notFound = new NotFoundPage(page)
  // A well-formed id of no match, the kept one in capitals, one digit pair
  // short, and no id at all.
  for (const id of ['ab'.repeat(32), matchId.toUpperCase(), matchId.slice(2), 'not-a-match']) {
    for (const path of [`/matches/${id}`, `/matches/${id}/games/1/scores/edit`]) {
      await notFound.goto(path)
      await expect(notFound.heading).toBeVisible()
    }
  }
})

test('Start match pressed twice at once keeps one match', async ({ page, context }) => {
  const newMatch = new NewMatchPage(page)
  await newMatch.goto()
  await newMatch.bestOf(3).click()
  await newMatch.startMatch.dblclick()
  const matchId = await scoredMatchId(page)
  const harness = new StorageHarness(await context.newPage())
  await harness.open()
  // A second Start match would have asked for the append lock before the
  // harness does: once the harness has held it, that one is kept too.
  await harness.holdLock()
  await harness.releaseLock()

  expect((await harness.keptMatchRecords()).map(({ id }) => id)).toEqual([matchId])
})

test('G2.3: a saved game, a corrected one and a cleared one are still so after a reload', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 5)
  await saveGame(page, matchId, 1, [11, 5])
  await saveGame(page, matchId, 2, [11, 3])
  await saveGame(page, matchId, 3, [4, 11])
  // Game 1 corrected, game 2 cleared.
  await saveGame(page, matchId, 1, [11, 7])
  const scoring = new ScoringPage(page)
  await scoring.goto(matchId, 2)
  await scoring.clear.click()
  await expect(scoring.heading).toHaveText('Enter game 2 score.')

  const details = new MatchDetailsPage(page)
  await details.goto(matchId)
  await expect(details.game(1).getByRole('cell')).toHaveText(['11', '7', 'You'])
  await expect(details.game(2).getByRole('cell')).toHaveText(['–', '–', 'Not played'])
  await expect(details.game(3).getByRole('cell')).toHaveText(['4', '11', 'Anonymous'])
  // The correction and the clear each replaced what was kept for their
  // game: one current entry each, not two to pick from.
  const harness = new StorageHarness(await context.newPage())
  await harness.open()
  const { current } = (await harness.views())[matchId]!
  expect(current[0]).toHaveLength(1)
  expect(current[1]).toHaveLength(1)
})

test('G2.4: with no connection, a match reopened shows its games and takes one more, still there after a reload', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  await saveGame(page, matchId, 1, [11, 5])
  await new App(page).waitUntilKept()

  await context.setOffline(true)
  const details = new MatchDetailsPage(page)
  await details.goto(matchId)
  await expect(details.game(1).getByRole('cell')).toHaveText(['11', '5', 'You'])
  await saveGame(page, matchId, 2, [9, 11])
  await details.goto(matchId)

  await expect(details.game(1).getByRole('cell')).toHaveText(['11', '5', 'You'])
  await expect(details.game(2).getByRole('cell')).toHaveText(['9', '11', 'Anonymous'])
})

test('G2.5: a match’s page open in one tab shows a game another tab saves, with no reload', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  const tabA = new MatchDetailsPage(page)
  await tabA.goto(matchId)
  await expect(tabA.noGames).toBeVisible()

  await saveGame(await context.newPage(), matchId, 1, [11, 6])

  await expect(tabA.game(1).getByRole('cell')).toHaveText(['11', '6', 'You'])
})

test('G2.6: two tabs saving one game at once leave one score for it, and both score records kept', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  const [tabA, tabB] = [page, await context.newPage()]
  const scorings = [new ScoringPage(tabA), new ScoringPage(tabB)]
  for (const [i, tab] of [tabA, tabB].entries()) {
    await scorings[i]!.goto(matchId, 1)
    // The tab's launch at startup takes the append lock too: let it settle.
    await new App(tab).firstLaunch()
  }
  await scorings[0]!.enter([11, 5])
  await scorings[1]!.enter([11, 9])
  const harness = new StorageHarness(await context.newPage())
  await harness.open()

  // Both saves start while the harness holds the append lock, so both are
  // waiting for it at once.
  await harness.holdLock()
  await scorings[0]!.save.click()
  await scorings[1]!.save.click()
  await harness.waitForQueued(2)
  await harness.releaseLock()
  for (const tab of [tabA, tabB]) await expect(tab).toHaveURL(/\/games\/2\/scores\/edit$/)

  expect(await scoreRecords(harness, matchId)).toHaveLength(2)
  expect((await harness.views())[matchId]!.current[0]).toHaveLength(1)
  const details = new MatchDetailsPage(page)
  await details.goto(matchId)
  await expect(details.games.getByRole('row', { name: /^Game \d/ })).toHaveCount(1)
})

// Each match is one `match` record: this device's player on one side, an
// anonymous side (no players) on the other, and no `player` record made for
// the opponent.
test('G2.7: two matches started on the form are two match records, each against an anonymous side, with no player record', async ({
  page,
  context,
}) => {
  const first = await startMatch(page, 3)
  // The second in the same page's life, through the app's own links.
  await new AppLayout(page).link('Matches').click()
  await new MatchesPage(page).newMatch.click()
  await new NewMatchPage(page).startMatch.click()
  await expect(page).not.toHaveURL(new RegExp(first))
  const second = await scoredMatchId(page)
  const harness = new StorageHarness(await context.newPage())
  await harness.open()

  const kept = await harness.keptMatchRecords()
  const sides = Object.fromEntries(kept.map(({ id, sides }) => [id, sides]))
  expect(Object.keys(sides).sort()).toEqual([first, second].sort())
  expect(sides[first]![0]).toHaveLength(1)
  expect(sides[first]![0]).toEqual(sides[second]![0])
  expect(sides[first]![1]).toEqual([])
  expect(sides[second]![1]).toEqual([])
  const kinds = (await harness.keptRecords()).map(({ kind }) => kind)
  expect(kinds).not.toContain('player')
  expect(kinds.filter((kind) => kind === 'match')).toHaveLength(2)
})

test('G2.8: with site data blocked, Start match says it couldn’t start the match and stays on the form', async ({
  baseURL,
}) => {
  const blocked = await blockedSiteData(baseURL!)
  try {
    const page = await blocked.context.newPage()
    const newMatch = new NewMatchPage(page)
    await newMatch.goto()
    await newMatch.bestOf(5).click()
    await newMatch.startMatch.click()

    await expect(newMatch.notStarted).toBeVisible()
    await expect(page).toHaveURL(/\/matches\/new$/)
    await expect(newMatch.bestOf(5)).toBeChecked()
  } finally {
    await blocked.close()
  }
})

test('with site data blocked, the list and a match’s page say the device won’t read them, not that there is nothing', async ({
  baseURL,
}) => {
  const blocked = await blockedSiteData(baseURL!)
  try {
    const page = await blocked.context.newPage()
    const matches = new MatchesPage(page)
    await matches.goto()
    await expect(matches.unreadable).toBeVisible()
    await expect(matches.empty).toHaveCount(0)

    const details = new MatchDetailsPage(page)
    await details.goto('ab'.repeat(32))
    await expect(details.unreadable).toBeVisible()
    await expect(new NotFoundPage(page).heading).toHaveCount(0)
  } finally {
    await blocked.close()
  }
})

test('a save the device refuses says the browser can’t save matches, keeps what is typed, and keeps nothing on the device', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  // A tab of a browser with no Web Locks: the device can't take the append
  // lock, so it refuses every write.
  const tab = await context.newPage()
  await tab.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined })
  })
  const scoring = new ScoringPage(tab)
  await scoring.goto(matchId, 1)
  await scoring.enter([11, 3])

  await scoring.save.click()

  await expect(scoring.unsupported).toContainText('Update your browser or try another browser.')
  await expect(tab).toHaveURL(/\/games\/1\/scores\/edit$/)
  await expect(scoring.yours).toHaveValue('11')
  await expect(scoring.theirs).toHaveValue('3')
  const harness = new StorageHarness(await context.newPage())
  await harness.open()
  expect(await scoreRecords(harness, matchId)).toEqual([])
})

// A scoring page shows the match as it is kept, live: another tab's write
// shows at once, with a notification (the user's rule: "we can change things
// in the background as long as theres some notification that it happened").

// R3, between real tabs.
test('another tab saving the game on a scoring page where a score is typed: the typed score stays, the page says so, and Save keeps the typed score', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  await saveGame(page, matchId, 1, [11, 5])
  const tabA = new ScoringPage(page)
  await tabA.goto(matchId, 2)
  await tabA.enter([11, 9])

  await saveGame(await context.newPage(), matchId, 2, [6, 11])

  await expect(tabA.updated).toHaveText('Game 2 updated.')
  await expect(tabA.heading).toHaveText('Edit game 2 score.')
  await expect(tabA.yours).toHaveValue('11')
  await expect(tabA.theirs).toHaveValue('9')
  await expect(page).toHaveURL(/\/games\/2\/scores\/edit$/)
  await tabA.save.click()
  // 11–9 decides the match: the dashboard.
  await expect(page).toHaveURL(/\/$/)
  const details = new MatchDetailsPage(page)
  await details.goto(matchId)
  await expect(details.game(2).getByRole('cell')).toHaveText(['11', '9', 'You'])
  const harness = new StorageHarness(await context.newPage())
  await harness.open()
  expect((await harness.views())[matchId]!.current[1]).toHaveLength(1)
})

// R1, between real tabs.
test('another tab correcting another game shows on a scoring page at once, tinted and read out; what is typed stays', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 5)
  await saveGame(page, matchId, 1, [11, 5])
  const tabA = new ScoringPage(page)
  await tabA.goto(matchId, 2)
  await tabA.enter([11, 9])

  await saveGame(await context.newPage(), matchId, 1, [5, 11])

  await expect(page.getByRole('link', { name: 'Game 1, 5–11' })).toBeVisible()
  await expect(tabA.updated).toHaveText('Game 1 updated.')
  await expect(tabA.tint).toHaveCount(1)
  await expect(tabA.heading).toHaveText('Enter game 2 score.')
  await expect(tabA.yours).toHaveValue('11')
  await expect(tabA.theirs).toHaveValue('9')
})

// R6, between real tabs.
test('another tab deciding the match: a scoring page of an empty game shows the finished notice, Save is off, what is typed stays, and the link goes to the match', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  await saveGame(page, matchId, 1, [11, 5])
  const tabA = new ScoringPage(page)
  await tabA.goto(matchId, 3)
  await tabA.enter([11, 9])

  // Game 2 decides the match: tab B goes to the dashboard.
  const tabB = await context.newPage()
  await saveGame(tabB, matchId, 2, [11, 4])
  await expect(tabB).toHaveURL(/\/$/)

  await expect(tabA.finished).toBeVisible()
  await expect(tabA.save).toBeDisabled()
  await expect(tabA.heading).toHaveText('Enter game 3 score.')
  await expect(tabA.yours).toHaveValue('11')
  await expect(tabA.theirs).toHaveValue('9')
  await tabA.theirs.press('Enter')
  await expect(page).toHaveURL(/\/games\/3\/scores\/edit$/)
  // The typed score can't be saved: leaving with it asks, as ever.
  await tabA.goToMatch.click()
  await page.getByRole('dialog', { name: 'Leave without saving?' })
    .getByRole('button', { name: 'Discard & leave' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/matches/${matchId}$`))
  const harness = new StorageHarness(await context.newPage())
  await harness.open()
  expect(await scoreRecords(harness, matchId)).toHaveLength(2)
})

// R5 (bug 1 of the second review; its repro, adv2b-probe P1): the router
// keeps the scoring page mounted across a match's games, and the page's
// memory of its own save ends with the save.
test('back on a game this page saved, another tab correcting it shows: the new score, read out', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 5)
  const tabA = new ScoringPage(page)
  await tabA.enter([11, 5])
  await tabA.save.click()
  await expect(page).toHaveURL(/\/games\/2\/scores\/edit$/)
  await page.getByRole('link', { name: 'Game 1, 11–5' }).click()
  await expect(tabA.heading).toHaveText('Edit game 1 score.')

  await saveGame(await context.newPage(), matchId, 1, [3, 11])

  await expect(tabA.yours).toHaveValue('3')
  await expect(tabA.theirs).toHaveValue('11')
  await expect(tabA.updated).toHaveText('Game 1 updated.')
})

// Every IndexedDB open in the tab fails while its sessionStorage says so:
// the device refusing reads for a while, as a storage error does.
async function refusableStorage(page: Page) {
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open
    IDBFactory.prototype.open = function (this: IDBFactory, ...args: [string, number?]) {
      if (sessionStorage.getItem('refuse') === '1') {
        throw new DOMException('The device refuses for now.', 'UnknownError')
      }
      return open.apply(this, args)
    }
  })
}

// R7 (bug 2 of the second review; its repro, g2b-adv1-unavailable): the
// page's loaders' read was refused, and the match becomes readable by the
// store's read after another tab's write, not by the loaders. The page
// never renders nothing.
test.describe('a scoring page the device couldn’t read, readable again when another tab saves a game', () => {
  for (const [what, score, shown] of [
    ['that decides the match: the finished notice', [11, 4], 'finished'],
    ['that leaves it undecided: the game to enter', [4, 11], 'game'],
  ] as const) {
    test(what, async ({ page, context }) => {
      const matchId = await startMatch(page, 3)
      await saveGame(page, matchId, 1, [11, 5])
      const tabA = await context.newPage()
      await refusableStorage(tabA)
      await tabA.goto('/')
      await tabA.evaluate(() => sessionStorage.setItem('refuse', '1'))
      const scoringA = new ScoringPage(tabA)
      await scoringA.goto(matchId, 3)
      await expect(new MatchDetailsPage(tabA).unreadable).toBeVisible()
      await tabA.evaluate(() => sessionStorage.removeItem('refuse'))

      await saveGame(page, matchId, 2, [...score])

      await expect(scoringA.heading).toHaveText('Enter game 3 score.')
      if (shown === 'finished') {
        await expect(scoringA.finished).toBeVisible()
        await expect(scoringA.save).toBeDisabled()
      } else {
        await expect(scoringA.finished).toHaveCount(0)
        await expect(scoringA.save).toBeEnabled()
      }
    })
  }
})

// R9: with reduced motion, the tint shows as it is for about 3 seconds
// (not cut to nothing by the theme's rule for every animation), then goes.
// Whether it animates is a style, which no test reads.
test('with reduced motion, the tint on a game changed elsewhere stays about 3 seconds, then is gone', async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const matchId = await startMatch(page, 5)
  const tabA = new ScoringPage(page)

  await saveGame(await context.newPage(), matchId, 2, [11, 4])
  await expect(tabA.updated).toHaveText('Game 2 updated.')
  const shownAt = Date.now()

  await expect(tabA.tint).toHaveCount(1)
  await page.waitForTimeout(Math.max(0, 2500 - (Date.now() - shownAt)))
  await expect(tabA.tint).toHaveCount(1, { timeout: 0 })
  await expect(tabA.tint).toHaveCount(0, { timeout: 2000 })
})

test('a score the rules refuse keeps nothing on the device: the game is still empty after a reload', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  const harness = new StorageHarness(await context.newPage())
  await harness.open()

  expect(await harness.setGameScore(matchId, 1, [11, 10])).toMatchObject({
    ok: false,
    reason: 'illegal',
  })

  expect(await scoreRecords(harness, matchId)).toEqual([])
  const details = new MatchDetailsPage(page)
  await details.goto(matchId)
  await expect(details.noGames).toBeVisible()
})

// A score is a signed record, kept for good and carried by sync: pressing
// Save again for the same score keeps no second one.
test('saving the score a game already has keeps no new record, and answers that it saved', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  const harness = new StorageHarness(await context.newPage())
  await harness.open()
  expect(await harness.setGameScore(matchId, 1, [11, 5])).toEqual({ ok: true })

  expect(await harness.setGameScore(matchId, 1, [11, 5])).toEqual({ ok: true })

  expect(await scoreRecords(harness, matchId)).toHaveLength(1)
  expect((await harness.views())[matchId]!.current[0]).toHaveLength(1)
})

// Two current scores for one game (two devices saved it, neither seeing the
// other's): a save settles them, even of the score both say.
test('saving the score a game has twice over keeps one more record, which settles it to one', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  const harness = new StorageHarness(await context.newPage())
  await harness.open()
  const both = await harness.makeRecords([
    { kind: 'score', match: matchId, slot: 1, score: [11, 5], replaces: [] },
    { kind: 'score', match: matchId, slot: 1, score: [11, 5], replaces: [] },
  ])
  expect(await harness.append(both.map(({ record }) => record))).toEqual({ ok: true })
  expect((await harness.views())[matchId]!.current[0]).toHaveLength(2)

  expect(await harness.setGameScore(matchId, 1, [11, 5])).toEqual({ ok: true })

  expect(await scoreRecords(harness, matchId)).toHaveLength(3)
  expect((await harness.views())[matchId]!.current[0]).toHaveLength(1)
})

test('Save double-clicked, and Enter pressed five times in the opponent’s field, each keep one score record for the game', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 5)
  const scoring = new ScoringPage(page)
  await scoring.enter([11, 5])
  await scoring.save.dblclick()
  await expect(page).toHaveURL(/\/games\/2\/scores\/edit$/)
  await scoring.enter([7, 11])
  await scoring.theirs.focus()
  for (let press = 0; press < 5; press++) await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/games\/3\/scores\/edit$/)
  const harness = new StorageHarness(await context.newPage())
  await harness.open()
  // A save pressed again would have asked for the append lock before the
  // harness does: once the harness has held it, that one is kept too.
  await harness.holdLock()
  await harness.releaseLock()

  expect(await scoreRecords(harness, matchId)).toHaveLength(2)
  const { current } = (await harness.views())[matchId]!
  expect(current.slice(0, 2).map((ids) => ids.length)).toEqual([1, 1])
})

// Black-box #12: after Start match, game 1 with nothing typed asks the
// browser nothing before the page goes, whatever the length: reloading,
// another address, or closing the tab.
for (const bestOf of [1, 3, 7]) {
  for (const leave of ['reload', 'another address', 'close'] as const) {
    test(`after Start match with best of ${bestOf}, leaving game 1 with nothing typed (${leave}) asks nothing`, async ({
      page,
    }) => {
      // Reached as a person does, through the app's own links.
      await page.goto('/')
      await page.getByRole('link', { name: 'New match' }).first().click()
      const newMatch = new NewMatchPage(page)
      await newMatch.bestOf(bestOf).click()
      await newMatch.startMatch.click()
      await expect(new ScoringPage(page).heading).toHaveText('Enter game 1 score.')
      let asked = false
      page.on('dialog', async (dialog) => {
        asked = true
        await dialog.accept()
      })

      if (leave === 'reload') await page.reload()
      else if (leave === 'another address') await page.goto('/matches')
      else {
        await page.close({ runBeforeUnload: true })
        await expect.poll(() => page.isClosed()).toBe(true)
      }

      expect(asked).toBe(false)
    })
  }
}

// Test gap T6 (adversary 1's probe): a hidden or frozen tab can miss
// another tab's announcement; when the page is shown again, every watched
// match is read again ('all', src/changes.ts), through the device's source.
test('a match’s page that missed another tab’s announcement shows the save once the page is shown again', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  // This tab's channel drops what it hears while `__drop` is set.
  await page.addInitScript(() => {
    const flags = window as unknown as { __drop: boolean }
    flags.__drop = false
    class Dropping extends BroadcastChannel {
      set onmessage(listener: ((event: MessageEvent) => void) | null) {
        super.onmessage = (event: MessageEvent) => {
          if (!flags.__drop) listener?.(event)
        }
      }
      get onmessage() {
        return super.onmessage
      }
    }
    window.BroadcastChannel = Dropping
  })
  const details = new MatchDetailsPage(page)
  await details.goto(matchId)
  await expect(details.noGames).toBeVisible()
  await page.evaluate(() => {
    ;(window as unknown as { __drop: boolean }).__drop = true
  })

  await saveGame(await context.newPage(), matchId, 1, [11, 6])
  // The announcement was dropped: the page still shows no games.
  await page.waitForTimeout(500)
  await expect(details.noGames).toBeVisible()

  await page.evaluate(() => {
    ;(window as unknown as { __drop: boolean }).__drop = false
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(details.game(1).getByRole('cell')).toHaveText(['11', '6', 'You'])
})

// Black-box #17: a score typed straight after Start match, before game 1's
// page has opened, is all there.
test('a score typed straight after Start match lands in game 1’s fields', async ({ page }) => {
  const newMatch = new NewMatchPage(page)
  await newMatch.goto()
  await newMatch.bestOf(3).click()

  await newMatch.startMatch.click()
  await page.keyboard.type('11')
  await page.keyboard.press('Enter')
  await page.keyboard.type('7')

  const scoring = new ScoringPage(page)
  await expect(scoring.heading).toHaveText('Enter game 1 score.')
  await expect(scoring.yours).toHaveValue('11')
  await expect(scoring.theirs).toHaveValue('7')
  await expect(scoring.theirs).toBeFocused()
})

// Black-box #2 (src/persist.ts): the browser is asked to keep the data once
// a match is kept, and not before. Whether it grants it is the browser's;
// this asks only that it was asked.
test('the browser is asked to keep the data after Start match, and not when an empty device opens', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const counted = window as unknown as { __persistAsked: number }
    counted.__persistAsked = 0
    const persist = StorageManager.prototype.persist
    StorageManager.prototype.persist = function (this: StorageManager) {
      counted.__persistAsked += 1
      return persist.call(this)
    }
  })
  const asked = () => page.evaluate(() => (window as unknown as { __persistAsked: number }).__persistAsked)
  const newMatch = new NewMatchPage(page)
  await newMatch.goto()
  await expect(newMatch.startMatch).toBeVisible()
  await page.waitForTimeout(300)
  expect(await asked()).toBe(0)

  await newMatch.startMatch.click()

  await expect(new ScoringPage(page).heading).toHaveText('Enter game 1 score.')
  await expect.poll(asked).toBe(1)
})

// Try again, on an empty game of a match decided while the device couldn't
// read it, goes to the dashboard (the route's guard) without showing that
// game's scoring page on the way. The component test of this (routes/
// matches/$matchId.test.tsx) passed while a real browser showed the page:
// a match already read reloads in the background.
test('Try again on an empty game of a match decided meanwhile goes to the dashboard, never showing its scoring page', async ({
  page,
  context,
}) => {
  const matchId = await startMatch(page, 3)
  await saveGame(page, matchId, 1, [11, 5])
  await saveGame(page, matchId, 2, [11, 4])
  const tab = await context.newPage()
  await refusableStorage(tab)
  await tab.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __seen: string[] }).__seen = seen
    new MutationObserver(() => {
      for (const heading of document.querySelectorAll('h1')) seen.push(heading.textContent ?? '')
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
  await tab.goto('/')
  await tab.evaluate(() => sessionStorage.setItem('refuse', '1'))
  await tab.goto(`/matches/${matchId}/games/3/scores/edit`)
  await expect(new MatchDetailsPage(tab).unreadable).toBeVisible()
  await tab.evaluate(() => sessionStorage.removeItem('refuse'))

  await tab.getByRole('button', { name: 'Try again' }).click()

  await expect(tab).toHaveURL(/\/$/)
  const seen = await tab.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
  expect(seen.filter((heading) => /game \d+ score/i.test(heading))).toEqual([])
})
