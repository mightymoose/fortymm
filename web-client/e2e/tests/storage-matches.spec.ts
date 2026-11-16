import { expect, test } from '../pages/test.ts'
import {
  type FailWrites,
  type Made,
  type State,
  StorageHarness,
  type View,
} from '../pages/storage.ts'

// The journal, the `matches` view the core computes from it and the rebuild
// (src/storage.ts) against real IndexedDB.
// No screen writes matches with it yet (tasks F and G2), so the tests call it
// through the test-only page in the "harness" deployment (../harness/), which
// makes `player`, `match` and `score` records with the core and this
// device's key, and appends them through withDeviceKey's store, as a commit
// will. Each test starts from a fresh browser profile. What needs no browser
// (the records append refuses, the failures when IndexedDB, Web Locks or the
// core is missing) is in src/storage.test.ts; the random sequences are in
// storage-matches-random.spec.ts.

test.use({ build: 'harness' })

type Created = { matchId: string; player: Made; match: Made }

// A new match against a fresh player: the player record, then the match
// record, in one append.
async function createMatch(
  harness: StorageHarness,
  { bestOf = 5, rated = false, terms = undefined as string | undefined } = {},
): Promise<Created> {
  const made = await makeMatch(harness, { bestOf, rated, terms })
  expect(await harness.append([made.player.record, made.match.record])).toEqual({ ok: true })
  return made
}

// The same, made and not appended.
async function makeMatch(
  harness: StorageHarness,
  { bestOf = 5, rated = false, terms = undefined as string | undefined } = {},
): Promise<Created> {
  const [player] = await harness.makeRecords([{ kind: 'player' }])
  const [match] = await harness.makeRecords([
    { kind: 'match', opponent: player.player!, bestOf, rated, terms },
  ])
  return { matchId: match.id, player, match }
}

// A score record for a game, made and not appended.
async function makeScore(
  harness: StorageHarness,
  matchId: string,
  slot: number,
  score: [number, number] | null,
  replaces: string[] = [],
): Promise<Made> {
  const [made] = await harness.makeRecords([{ kind: 'score', match: matchId, slot, score, replaces }])
  return made
}

// A score record for a game, appended on its own.
async function saveScore(
  harness: StorageHarness,
  matchId: string,
  slot: number,
  score: [number, number] | null,
  replaces: string[] = [],
): Promise<Made> {
  const made = await makeScore(harness, matchId, slot, score, replaces)
  expect(await harness.append([made.record])).toEqual({ ok: true })
  return made
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

// A view row without its journal number.
function stateOf(view: View | undefined): State | undefined {
  if (view === undefined) return undefined
  const { seq: _seq, ...state } = view
  return state
}

// The journal number of a record (by its id).
async function seqOf(harness: StorageHarness, id: string): Promise<number> {
  const journal = (await harness.readStore('journal')) as [number, { id: string }][]
  const row = journal.find(([, value]) => value.id === id)
  if (row === undefined) throw new Error(`No journal row for ${id}`)
  return row[0]
}

// The two ways the harness makes a write fail: refused at once (the call
// throws), or aborted once it succeeded (the transaction fails at commit,
// asynchronously, after its requests went through).
const failures: FailWrites[] = ['refused', 'aborted']

// Every store a match is kept in, as IndexedDB holds it.
async function everything(harness: StorageHarness) {
  return {
    records: await harness.readStore('records'),
    journal: await harness.readStore('journal'),
    matches: await harness.readStore('matches'),
  }
}

// A match with saves, a correction and a clear, in three appends: what the
// tests of the view build on.
async function playedMatch(harness: StorageHarness) {
  const created = await createMatch(harness, { bestOf: 5, rated: true })
  const game1 = await saveScore(harness, created.matchId, 1, [11, 9])
  const game2 = await saveScore(harness, created.matchId, 2, [7, 11])
  await saveScore(harness, created.matchId, 1, [11, 13], [game1.id])
  const game3 = await saveScore(harness, created.matchId, 3, [11, 4])
  await saveScore(harness, created.matchId, 3, null, [game3.id])
  return { ...created, game2 }
}

for (const how of failures) {
  test(`D1: when writing a match’s view row fails (${how}), neither of its records nor their journal rows are kept, and the append is storage-unavailable`, async ({
    page,
  }) => {
    const harness = new StorageHarness(page)
    await harness.open()
    const { player, match } = await makeMatch(harness)

    await harness.failWrites('matches', null, how)
    const result = await harness.append([player.record, match.record])
    await harness.stopFailing()

    expect(result).toEqual({ ok: false, reason: 'storage-unavailable' })
    expect(await harness.counts()).toMatchObject({ records: 0, journal: 0, matches: 0 })
    expect(await harness.loadMatch(match.id)).toEqual({ ok: true, match: null })
  })

  for (const failing of ['records', 'journal'] as const) {
    test(`D1: when writing to ${failing} fails (${how}), none of a new match’s records, journal rows or view row is kept`, async ({
      page,
    }) => {
      const harness = new StorageHarness(page)
      await harness.open()
      const { player, match } = await makeMatch(harness)

      await harness.failWrites(failing, null, how)
      const result = await harness.append([player.record, match.record])
      await harness.stopFailing()

      expect(result).toEqual({ ok: false, reason: 'storage-unavailable' })
      expect(await harness.counts()).toMatchObject({ records: 0, journal: 0, matches: 0 })
    })
  }
}

test('D1: a failed save leaves the match as it was: its records, journal and view row', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const { matchId } = await playedMatch(harness)
  const before = {
    records: await harness.readStore('records'),
    journal: await harness.readStore('journal'),
    views: await harness.views(),
  }
  const save = await makeScore(harness, matchId, 4, [11, 2])

  await harness.failWrites('matches', matchId)
  const result = await harness.append([save.record])
  await harness.stopFailing()

  expect(result).toEqual({ ok: false, reason: 'storage-unavailable' })
  expect({
    records: await harness.readStore('records'),
    journal: await harness.readStore('journal'),
    views: await harness.views(),
  }).toEqual(before)
})

test('16: a write made to fail at the view of its third match leaves none of the three matches changed', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const matches = [
    await createMatch(harness),
    await createMatch(harness),
    await createMatch(harness),
  ]
  for (const { matchId } of matches) await saveScore(harness, matchId, 1, [11, 5])
  const before = await everything(harness)
  const saves = await harness.makeRecords(
    matches.map(({ matchId }) => ({
      kind: 'score' as const,
      match: matchId,
      slot: 2,
      score: [11, 7] as [number, number],
      replaces: [],
    })),
  )

  await harness.failWrites('matches', matches[2].matchId)
  const result = await harness.append(saves.map(({ record }) => record))
  await harness.stopFailing()

  expect(result).toEqual({ ok: false, reason: 'storage-unavailable' })
  expect(await everything(harness)).toEqual(before)
})

test('D2: the same records appended twice are kept once, with one journal row each, the view unchanged, and tell neither tab anything', async ({
  context,
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const other = new StorageHarness(await context.newPage())
  await other.open()
  const { player, match } = await playedMatch(harness)
  const score = await saveScore(harness, match.id, 4, [11, 3])
  const later = await createMatch(harness)
  const laterScore = await makeScore(harness, later.matchId, 1, [11, 2])
  const before = { counts: await harness.counts(), views: await harness.views() }
  await harness.listen()
  await other.listen()

  const results = await harness.appendEach([
    [player.record, match.record],
    [score.record, score.record],
  ])

  expect(results).toEqual([{ ok: true }, { ok: true }])
  expect({ counts: await harness.counts(), views: await harness.views() }).toEqual(before)
  // Then one write that keeps something, so the other tab has had time to
  // hear anything sent before it.
  expect(await harness.append([laterScore.record])).toEqual({ ok: true })
  const touched = { account: false, matches: [later.matchId], revision: 0 }
  await expect.poll(() => other.heard()).toContainEqual(touched)
  expect(await other.heard()).toEqual([touched])
  expect(await harness.heard()).toEqual([touched])
})

test('D2: a record with an id already kept, signed again, is not kept a second time: the first bytes stay, and the view is unchanged', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const { match } = await playedMatch(harness)
  const score = await saveScore(harness, match.id, 4, [11, 3])
  const before = { counts: await harness.counts(), views: await harness.views() }
  const [again] = await harness.makeRecords([{ kind: 'again', record: score.record }])

  const result = await harness.append([again.record])

  expect(again.id).toBe(score.id)
  expect(again.record).not.toBe(score.record)
  expect(result).toEqual({ ok: true })
  expect({ counts: await harness.counts(), views: await harness.views() }).toEqual(before)
  const records = (await harness.readStore('records')) as [string, string][]
  expect(records.find(([id]) => id === score.id)?.[1]).toBe(score.record)
})

test('D3: a match reads back after a reload with its best of, rated, and no games, and no typed name', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const rated = await createMatch(harness, { bestOf: 5, rated: true })
  const unrated = await createMatch(harness, { bestOf: 3, rated: false })

  await harness.reload()

  // toEqual: a match with an opponentName, even null, is not equal.
  expect(await harness.loadMatch(rated.matchId)).toEqual({
    ok: true,
    match: { matchId: rated.matchId, bestOf: 5, rated: true, games: [] },
  })
  expect(await harness.loadMatch(unrated.matchId)).toEqual({
    ok: true,
    match: { matchId: unrated.matchId, bestOf: 3, rated: false, games: [] },
  })
})

test('D4: saved, corrected and cleared games read back after a reload', async ({ page }) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const { matchId } = await playedMatch(harness)

  await harness.reload()

  // Game 1 corrected to 11-13, game 2 saved, game 3 saved then cleared.
  expect(await harness.loadMatch(matchId)).toEqual({
    ok: true,
    match: {
      matchId,
      bestOf: 5,
      rated: true,
      games: [
        [11, 13],
        [7, 11],
      ],
    },
  })
})

test('D4: the held loadMatch gives the match with, per game, the ids of the entries now current', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const created = await createMatch(harness)
  const game1 = await saveScore(harness, created.matchId, 1, [11, 9])
  const corrected = await saveScore(harness, created.matchId, 1, [11, 13], [game1.id])
  const game2 = await saveScore(harness, created.matchId, 2, [7, 11])
  const cleared = await saveScore(harness, created.matchId, 2, null, [game2.id])

  expect(await harness.heldLoadMatch(created.matchId)).toEqual({
    ok: true,
    match: {
      matchId: created.matchId,
      bestOf: 5,
      rated: false,
      games: [[11, 13]],
      current: [[corrected.id], [cleared.id]],
    },
  })
})

test('D5: the list is every match, newest first, after a reload', async ({ page }) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const first = await createMatch(harness, { bestOf: 1 })
  const second = await createMatch(harness, { bestOf: 7, rated: true })
  const third = await createMatch(harness, { bestOf: 3 })

  await harness.reload()

  expect(await harness.loadMatches()).toEqual({
    ok: true,
    matches: [
      { matchId: third.matchId, bestOf: 3, rated: false },
      { matchId: second.matchId, bestOf: 7, rated: true },
      { matchId: first.matchId, bestOf: 1, rated: false },
    ],
  })
})

test('17: the list is newest first by when each match record arrived, also when an older match’s scores arrived after newer matches, or a match’s score before every match', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  // The fourth match's score arrives first of all, before any match record.
  const early = await makeMatch(harness)
  await saveScore(harness, early.matchId, 1, [11, 6])
  const created: Created[] = []
  for (let i = 0; i < 6; i++) {
    if (i === 3) {
      expect(await harness.append([early.player.record, early.match.record])).toEqual({ ok: true })
      created.push(early)
    } else {
      created.push(await createMatch(harness))
    }
  }
  // Ids are random, so they can fall in the order the matches were made, or
  // its reverse (1 time in 360 for six), where an order by id would pass:
  // one more match until they don't.
  const ids = () => created.map(({ matchId }) => matchId)
  const byId = () => [...ids()].sort()
  while (sameOrder(byId(), ids()) || sameOrder(byId().reverse(), ids())) {
    created.push(await createMatch(harness))
  }
  // The oldest two get scores after every match was made, the oldest last.
  await saveScore(harness, created[1].matchId, 1, [11, 3])
  await saveScore(harness, created[0].matchId, 1, [11, 3])
  const newestFirst = ids().reverse()

  const loaded = await harness.loadMatches()

  expect(loaded.ok && loaded.matches.map(({ matchId }) => matchId)).toEqual(newestFirst)
})

test('D6: the matches view can be dropped and rebuilt from the journal, with the same keys and the same rows', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  await playedMatch(harness)
  await playedMatch(harness)
  const third = await createMatch(harness, { bestOf: 7 })
  await saveScore(harness, third.matchId, 6, [11, 8])
  const before = await harness.readStore('matches')
  expect(before).toHaveLength(3)

  await harness.clearStore('matches')
  expect(await harness.readStore('matches')).toEqual([])
  const result = await harness.rebuildViews()

  expect(result).toEqual({ ok: true })
  expect(await harness.readStore('matches')).toEqual(before)
})

test('D6: a rebuild over a view with a wrong row, a missing row and a row no record gives puts back exactly the rows the journal gives', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const wrong = await playedMatch(harness)
  const missing = await playedMatch(harness)
  const right = await createMatch(harness, { bestOf: 7 })
  await saveScore(harness, right.matchId, 6, [11, 8])
  const before = await harness.readStore('matches')
  expect(before).toHaveLength(3)
  const views = await harness.views()
  // A row with other games, an older journal number and a field the view
  // doesn't have, as an older derivation or shape would leave.
  await harness.putEntry('matches', wrong.matchId, {
    ...views[wrong.matchId],
    games: [[11, 0]],
    seq: 1,
    shape: 'older',
  })
  await harness.deleteEntry('matches', missing.matchId)
  await harness.putEntry('matches', 'cd'.repeat(32), { stale: true })
  expect(await harness.readStore('matches')).not.toEqual(before)

  expect(await harness.rebuildViews()).toEqual({ ok: true })

  expect(await harness.readStore('matches')).toEqual(before)
})

for (const how of failures) {
  test(`D6: a rebuild that fails (${how}) at its second match leaves the view as it was, and tells neither tab anything`, async ({
    context,
    page,
  }) => {
    const harness = new StorageHarness(page)
    await harness.open()
    const other = new StorageHarness(await context.newPage())
    await other.open()
    const first = await createMatch(harness)
    const second = await createMatch(harness)
    await saveScore(harness, second.matchId, 1, [11, 4])
    const before = await everything(harness)
    expect(before.matches).toHaveLength(2)
    // Second in the index's order: rows are rewritten by match id.
    const later = [first.matchId, second.matchId].sort()[1]
    const score = await makeScore(harness, first.matchId, 1, [11, 5])
    await harness.listen()
    await other.listen()

    await harness.failWrites('matches', later, how)
    const result = await harness.rebuildViews()
    await harness.stopFailing()

    expect(result).toEqual({ ok: false, reason: 'storage-unavailable' })
    expect(await everything(harness)).toEqual(before)
    // Then one write that succeeds, so the other tab has had time to hear
    // anything sent before it.
    expect(await harness.append([score.record])).toEqual({ ok: true })
    const touched = { account: false, matches: [first.matchId], revision: 0 }
    await expect.poll(() => other.heard()).toContainEqual(touched)
    expect(await other.heard()).toEqual([touched])
    expect(await harness.heard()).toEqual([touched])
  })
}

test('D7: after each of several appends, a match’s view row is what the core gives for its kept records, with the journal number of its match record', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const { matchId, match } = await createMatch(harness, { bestOf: 5 })
  const steps: [number, [number, number] | null, 'replace' | 'keep'][] = [
    [1, [11, 9], 'keep'],
    [3, [4, 11], 'keep'],
    [1, [11, 13], 'replace'],
    [3, null, 'replace'],
    [2, [12, 10], 'keep'],
    [2, [10, 12], 'keep'], // names nothing: two current entries for game 2
  ]
  const saved: Made[][] = [[], [], [], [], []]
  for (const [slot, score, mode] of steps) {
    const made = await saveScore(harness, matchId, slot, score, mode === 'replace' ? saved[slot].map(({ id }) => id) : [])
    saved[slot].push(made)

    const views = await harness.views()
    const expected = await harness.expectedViews()
    expect(stateOf(views[matchId])).toEqual(expected[matchId])
    expect(views[matchId].seq).toBe(await seqOf(harness, match.id))
  }
})

for (const how of failures) {
  test(`D9: a write tells this tab and another which matches it touched; a failed write (${how}) tells neither`, async ({
    context,
    page,
  }) => {
    const writer = new StorageHarness(page)
    await writer.open()
    const other = new StorageHarness(await context.newPage())
    await other.open()
    const first = await createMatch(writer)
    const second = await createMatch(writer)
    const saves = await writer.makeRecords([
      { kind: 'score', match: first.matchId, slot: 1, score: [11, 1], replaces: [] },
      { kind: 'score', match: second.matchId, slot: 1, score: [11, 2], replaces: [] },
    ])
    const failed = await makeScore(writer, first.matchId, 2, [11, 3])
    await writer.listen()
    await other.listen()

    await writer.failWrites('matches', null, how)
    expect(await writer.append([failed.record])).toEqual({ ok: false, reason: 'storage-unavailable' })
    await writer.stopFailing()
    expect(await writer.append(saves.map(({ record }) => record))).toEqual({ ok: true })

    // The other tab hears in order: once it has heard the write that
    // succeeded, it has heard anything the failed one sent.
    const touched = { account: false, matches: [first.matchId, second.matchId], revision: 0 }
    await expect.poll(() => other.heard()).toContainEqual(touched)
    expect(await other.heard()).toEqual([touched])
    expect(await writer.heard()).toEqual([touched])
  })
}

test('D9: a rebuild tells this tab and another that any match may have changed', async ({
  context,
  page,
}) => {
  const writer = new StorageHarness(page)
  await writer.open()
  const other = new StorageHarness(await context.newPage())
  await other.open()
  await createMatch(writer)
  await writer.listen()
  await other.listen()

  expect(await writer.rebuildViews()).toEqual({ ok: true })

  const all = { account: false, matches: 'all', revision: 0 }
  await expect.poll(() => other.heard()).toEqual([all])
  expect(await writer.heard()).toEqual([all])
})

test('D12: a match id nobody made is no match, not a failure', async ({ page }) => {
  const harness = new StorageHarness(page)
  await harness.open()
  await createMatch(harness)
  const nobodys = 'ab'.repeat(32)

  expect(await harness.loadMatch(nobodys)).toEqual({ ok: true, match: null })
  expect(await harness.heldLoadMatch(nobodys)).toEqual({ ok: true, match: null })
})

test('D12: on a fresh device, the list is empty and a match is none, not a failure', async ({ page }) => {
  const harness = new StorageHarness(page)
  await harness.open()

  expect(await harness.loadMatches()).toEqual({ ok: true, matches: [] })
  expect(await harness.loadMatch('ab'.repeat(32))).toEqual({ ok: true, match: null })
})

for (const { name, terms, expected } of [
  // Terms of layout version 2, best of 5, rated: this build can't read them.
  { name: 'terms this build can’t read', terms: 'a3000201050201', expected: null },
  // Valid terms of layout 1 (core/FORMAT.md, section 15), best of 9.
  { name: 'a best of the app doesn’t offer (9)', terms: 'a3000101090200', expected: { bestOf: 9, rated: false } },
]) {
  test(`a match with ${name} has its view row, and is left out of loadMatch and loadMatches`, async ({
    page,
  }) => {
    const harness = new StorageHarness(page)
    await harness.open()
    const shown = await createMatch(harness)
    const hidden = await createMatch(harness, { terms })
    await saveScore(harness, hidden.matchId, 1, [11, 2])

    const views = await harness.views()
    expect(views[hidden.matchId].terms).toEqual(expected)
    expect(stateOf(views[hidden.matchId])).toEqual((await harness.expectedViews())[hidden.matchId])
    expect(await harness.loadMatch(hidden.matchId)).toEqual({ ok: true, match: null })
    const listed = await harness.loadMatches()
    expect(listed.ok && listed.matches.map(({ matchId }) => matchId)).toEqual([shown.matchId])
  })
}

test('a score kept before its match record has no view row; once the match record arrives, the row counts it, with the journal number of the match record', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const { matchId, player, match } = await makeMatch(harness, { bestOf: 3 })
  const score = await makeScore(harness, matchId, 2, [11, 6])

  expect(await harness.append([score.record])).toEqual({ ok: true })
  expect(await harness.views()).toEqual({})
  expect(await harness.loadMatch(matchId)).toEqual({ ok: true, match: null })

  expect(await harness.append([player.record, match.record])).toEqual({ ok: true })
  const loaded = await harness.loadMatch(matchId)
  expect(loaded.ok && loaded.match?.games).toEqual([null, [11, 6]])
  const seq = await seqOf(harness, match.id)
  expect(seq).toBeGreaterThan(await seqOf(harness, score.id))
  expect((await harness.views())[matchId].seq).toBe(seq)
})

test('14: the same records, appended in another order, split across appends, or with repeats, leave the same rows in the matches view, apart from the journal number', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const a = await makeMatch(harness, { bestOf: 5 })
  const b = await makeMatch(harness, { bestOf: 3, rated: true })
  const a1 = await makeScore(harness, a.matchId, 1, [11, 9])
  const a1fix = await makeScore(harness, a.matchId, 1, [9, 11], [a1.id])
  const a2 = await makeScore(harness, a.matchId, 2, [11, 7])
  const a2clear = await makeScore(harness, a.matchId, 2, null, [a2.id])
  const a4 = await makeScore(harness, a.matchId, 4, [13, 11])
  const b1 = await makeScore(harness, b.matchId, 1, [11, 0])
  const b1other = await makeScore(harness, b.matchId, 1, [0, 11])
  const b3 = await makeScore(harness, b.matchId, 3, [11, 1])
  const r = (made: Made) => made.record
  const all = [a.player, a.match, b.player, b.match, a1, a1fix, a2, a2clear, a4, b1, b1other, b3].map(r)
  const orders: { name: string; batches: string[][] }[] = [
    { name: 'as made, in one append', batches: [all] },
    { name: 'reversed, one record per append', batches: [...all].reverse().map((record) => [record]) },
    {
      name: 'scores first, split, with repeats',
      batches: [
        [r(a2clear), r(b3), r(a1fix)],
        [r(a2), r(a2clear), r(b1other)],
        [r(b.match), r(a4)],
        [r(a.match), r(a.player), r(a1), r(b1)],
        [r(b.player), r(a.match), r(b3)],
        all,
      ],
    },
  ]

  const rows: Record<string, State | undefined>[] = []
  for (const { batches } of orders) {
    for (const store of ['records', 'journal', 'matches'] as const) await harness.clearStore(store)
    expect(await harness.appendEach(batches)).toEqual(batches.map(() => ({ ok: true })))
    const views = await harness.views()
    rows.push(Object.fromEntries(Object.entries(views).map(([id, view]) => [id, stateOf(view)])))
  }

  expect(Object.keys(rows[0]).sort()).toEqual([a.matchId, b.matchId].sort())
  expect(rows[0]).toEqual(await harness.expectedViews())
  expect(rows[1]).toEqual(rows[0])
  expect(rows[2]).toEqual(rows[0])
})

test('15: two pages appending to the same match at once leave a view row equal to what the core gives for every record kept, and both pages’ records are kept', async ({
  context,
  page,
}) => {
  const first = new StorageHarness(page)
  await first.open()
  const second = new StorageHarness(await context.newPage())
  await second.open()
  const { matchId } = await createMatch(first, { bestOf: 7 })
  // Enough appends from each page that they interleave many times.
  const each = 40
  const firstScores = await first.makeRecords(
    Array.from({ length: each }, (_, i) => ({
      kind: 'score' as const,
      match: matchId,
      slot: (i % 7) + 1,
      score: [11, i] as [number, number],
      replaces: [],
    })),
  )
  const secondScores = await second.makeRecords(
    Array.from({ length: each }, (_, i) => ({
      kind: 'score' as const,
      match: matchId,
      slot: ((i + 3) % 7) + 1,
      score: [i, 11] as [number, number],
      replaces: [],
    })),
  )

  const [firstResults, secondResults] = await Promise.all([
    first.appendEach(firstScores.map(({ record }) => [record])),
    second.appendEach(secondScores.map(({ record }) => [record])),
  ])

  expect([...firstResults, ...secondResults].every((result) => result.ok)).toBe(true)
  const kept = ((await first.readStore('records')) as [string, string][]).map(([id]) => id)
  expect(kept).toEqual(expect.arrayContaining([...firstScores, ...secondScores].map(({ id }) => id)))
  expect(stateOf((await first.views())[matchId])).toEqual((await first.expectedViews())[matchId])
})
