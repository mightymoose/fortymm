import { expect, test } from '../pages/test.ts'
import {
  type CommitAnswer,
  type CommitSpec,
  type SignFault,
  StorageHarness,
} from '../pages/storage.ts'

// The journal's commit (src/journal.ts), with the real device key, Web Locks
// and IndexedDB. The tests call it directly,
// through the test-only page in the "harness" deployment (../harness/),
// which runs a few fixed drafts: create a match (a player, then the match),
// score a game on what the held store reads, or refuse. Each test starts
// from a fresh browser profile, with no first launch: the storage harness
// page runs none. The failures when the core, the key, storage or Web Locks
// is missing are in src/journal.test.ts.

test.use({ build: 'harness' })

const createMatch: CommitSpec = { kind: 'create', bestOf: 3, rated: false }

function scoreGame(match: string, game: number, score: [number, number] | null): CommitSpec {
  return { kind: 'score', match, game, score }
}

// The value of a commit that kept its records.
function committed(answer: CommitAnswer) {
  if (typeof answer === 'string' || !answer.ok) {
    throw new Error(`The commit kept nothing: ${JSON.stringify(answer)}`)
  }
  return answer.value
}

// A match created by a commit: its id, and the player record's.
async function created(harness: StorageHarness) {
  const [player, match] = committed(await harness.commit(createMatch)).made
  return { player, match }
}

// Every store a commit writes, as IndexedDB holds it.
async function everything(harness: StorageHarness) {
  return {
    records: await harness.readStore('records'),
    journal: await harness.readStore('journal'),
    matches: await harness.readStore('matches'),
  }
}

test('F1: a commit keeps the records its draft made, each verifying and signed by this device’s key', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  await harness.storeOwnHello()
  const { publicKey } = await harness.expectedUser()

  const { made } = committed(await harness.commit(createMatch))

  const kept = (await harness.keptRecords()).filter(({ kind }) => kind !== 'hello')
  expect(kept.map(({ id }) => id).sort()).toEqual([...made].sort())
  expect(kept).toEqual(
    expect.arrayContaining(made.map((id) => ({ id, kind: expect.any(String), verifies: true, signer: publicKey }))),
  )
  expect(await harness.loadMatch(made[1])).toEqual({
    ok: true,
    match: { matchId: made[1], bestOf: 3, rated: false, games: [] },
  })
})

test('F1: a match a commit made has this device’s own player on one side and the player record’s new player on the other', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const me = await harness.ownPlayerId()

  const { match } = await created(harness)

  const view = (await harness.views())[match]
  expect(view.sides[0]).toEqual([me])
  expect(view.sides[1]).toHaveLength(1)
  expect(view.sides[1][0]).not.toBe(me)
})

test('F1: a commit keeps its draft’s records in the order the draft gave them', async ({ page }) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const { made } = committed(await harness.commit(createMatch))

  const journal = (await harness.readStore('journal')) as [number, { id: string }][]
  expect(journal.map(([, row]) => row.id)).toEqual(made)
})

test('F1: committing the same draft twice makes different records, each with its own random value (design 4.5)', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const first = committed(await harness.commit(createMatch)).made
  const second = committed(await harness.commit(createMatch)).made

  expect(new Set([...first, ...second]).size).toBe(4)
  expect(await harness.counts()).toMatchObject({ records: 4, journal: 4, matches: 2 })
})

const refusal = { reason: 'not-clearable', message: 'Game 2 has no score to clear.' } as const

test('F1: a record make didn’t make in this commit, signed by another key, is refused, and nothing is kept', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const answer = await harness.commit({ kind: 'foreign', from: 'another-key' })

  expect(answer).toEqual({ ok: false, reason: 'record-refused' })
  expect(await harness.keptRecords()).toEqual([])
})

test('F1: a record make didn’t make in this commit, kept by an earlier one, is refused, and nothing is kept', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  await created(harness)
  const before = await everything(harness)

  const answer = await harness.commit({ kind: 'foreign', from: 'kept' })

  expect(answer).toEqual({ ok: false, reason: 'record-refused' })
  expect(await everything(harness)).toEqual(before)
})

test('F2: a draft can’t write through the store it is given: one that tries to append, then refuses, keeps nothing', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const answer = await harness.commit({ kind: 'write-then-refuse', write: 'append', refusal })

  expect(answer).toEqual({ ok: false, ...refusal })
  expect(await harness.counts()).toMatchObject({ records: 0, journal: 0, matches: 0 })
})

test('F2: a draft can’t write through the store it is given: one that tries to make another key’s user this device’s, then refuses, leaves this device’s user as it was', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  await harness.storeOwnHello()
  const me = await harness.loadMe()

  const answer = await harness.commit({ kind: 'write-then-refuse', write: 'me', refusal })

  expect(answer).toEqual({ ok: false, ...refusal })
  expect(await harness.loadMe()).toEqual(me)
  expect(await harness.counts()).toMatchObject({ records: 1, users: 1 })
})

test('F2: a draft that refuses, after making a record, keeps nothing and answers its refusal as it gave it', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  await created(harness)
  const before = await everything(harness)

  const answer = await harness.commit({ kind: 'refuse', refusal })

  expect(answer).toEqual({ ok: false, ...refusal })
  expect(await everything(harness)).toEqual(before)
})

test('F2: a score for a match that isn’t kept is refused, and nothing is kept', async ({ page }) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const answer = await harness.commit(scoreGame('ab'.repeat(32), 1, [11, 5]))

  expect(answer).toEqual({
    ok: false,
    reason: 'missing',
    message: 'This match isn’t on this device.',
  })
  expect(await harness.counts()).toMatchObject({ records: 0, journal: 0, matches: 0 })
})

test('F3: of two commits started together on one page, the second draft’s read sees the first’s record', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const { match } = await created(harness)

  const [first, second] = (
    await harness.commitTogether([scoreGame(match, 1, [11, 5]), scoreGame(match, 1, [11, 7])])
  ).map(committed)

  expect(first.read).toEqual([])
  expect(second.read).toEqual(first.made)
  const view = (await harness.views())[match]
  expect(view.games).toEqual([[11, 7]])
  expect(view.current).toEqual([second.made])
})

test('F4: on a device whose first launch never ran, a commit keeps its records, verifying and signed by the device key, and makes no hello', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  expect(await harness.counts()).toMatchObject({ records: 0, users: 0, me: 0 })

  const { made } = committed(await harness.commit(createMatch))

  const { publicKey } = await harness.expectedUser()
  expect(await harness.keptRecords()).toEqual(
    expect.arrayContaining([
      { id: made[0], kind: 'player', verifies: true, signer: publicKey },
      { id: made[1], kind: 'match', verifies: true, signer: publicKey },
    ]),
  )
  expect(await harness.keptRecords()).toHaveLength(2)
  expect(await harness.counts()).toMatchObject({ users: 0, me: 0 })
  expect(await harness.loadMe()).toEqual({ ok: true, user: null })
})

const faults: SignFault[] = ['throws', 'truncated', 'wrong-key']

for (const fault of faults) {
  test(`6: when the second record’s signature fails (${fault}), a commit is signing-unavailable and keeps neither record`, async ({
    page,
  }) => {
    const harness = new StorageHarness(page)
    await harness.open()

    const answer = await harness.commit({ ...createMatch, fault })

    expect(answer).toEqual({ ok: false, reason: 'signing-unavailable' })
    expect(await harness.counts()).toMatchObject({ records: 0, journal: 0, matches: 0 })
  })
}

test('6: a draft that catches the second record’s failed signature and gives the first alone to keep still keeps nothing', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const answer = await harness.commit({ ...createMatch, fault: 'throws', swallow: true })

  expect(answer).toEqual({ ok: false, reason: 'signing-unavailable' })
  expect(await harness.counts()).toMatchObject({ records: 0, journal: 0, matches: 0 })
})

test('6: a draft that catches its body builder’s error and gives the rest to keep makes the commit throw that error, and keeps nothing', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const answer = await harness.commit({ kind: 'builder-throws' })

  expect(answer).toBe('threw: Error: A bug in the body builder')
  expect(await harness.counts()).toMatchObject({ records: 0, journal: 0, matches: 0 })
})

test('a draft whose own code throws makes the commit throw, keeps nothing, and releases the lock', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const answer = await harness.commit({ kind: 'throws' })

  expect(answer).toBe('threw: Error: A bug in the draft')
  expect(await harness.counts()).toMatchObject({ records: 0, journal: 0, matches: 0 })
  committed(await harness.commit(createMatch))
})

test('7: two pages scoring the same game of one match at once both decide on what is on disk, both records are kept, and the view is what the core gives for every kept record', async ({
  context,
}) => {
  const [a, b] = [
    new StorageHarness(await context.newPage()),
    new StorageHarness(await context.newPage()),
  ]
  await a.open()
  await b.open()
  const { match } = await created(a)

  // Both commits queue for the lock a holds, a's first, before either runs.
  await a.holdLock()
  await a.start('a', 'commit', scoreGame(match, 1, [11, 5]))
  await a.waitForQueued(1)
  await b.start('b', 'commit', scoreGame(match, 1, [11, 7]))
  await a.waitForQueued(2)
  await a.releaseLock()
  await expect.poll(() => a.answer('a')).not.toBe('pending')
  await expect.poll(() => b.answer('b')).not.toBe('pending')
  const first = committed((await a.answer('a')) as CommitAnswer)
  const second = committed((await b.answer('b')) as CommitAnswer)

  expect(first.read).toEqual([])
  expect(second.read).toEqual(first.made)
  const kept = (await a.keptRecords()).map(({ id }) => id)
  expect(kept).toEqual(expect.arrayContaining([...first.made, ...second.made]))
  const { seq: _seq, ...state } = (await a.views())[match]
  expect(state).toEqual((await a.expectedViews())[match])
  expect(state.current).toEqual([second.made])
})
