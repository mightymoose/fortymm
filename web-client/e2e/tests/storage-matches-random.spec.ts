import { expect, test } from '../pages/test.ts'
import { type Made, type Spec, StorageHarness, type View } from '../pages/storage.ts'

// Random sequences of saves, corrections and clears over several matches,
// appended through withDeviceKey's store (src/storage.ts), against real
// IndexedDB. After every append, every match's row in the `matches` view
// must be what the core's matchState gives for that match's kept records
// (worked out by the harness from the records alone); after the last one,
// a rebuild over a damaged view must give back the same view.
//
// Seeded, so a failure reproduces: each run draws a seed, prints it, attaches
// it to the test and names it in every failure. To run one seed again, set
// `fixedSeed` below to it while debugging (never commit it set).

test.use({ build: 'harness' })

const appends = 300
const reloadEvery = 100
const fixedSeed: number | null = null

// mulberry32: a small seeded generator, enough to pick operations.
function generator(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (below: number) => Math.floor(next() * below)
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]
  const chance = (p: number) => next() < p
  const shuffle = <T>(items: T[]): T[] => {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(i + 1)
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }
  return { int, pick, chance, shuffle }
}

type Match = { id: string; bestOf: number; scores: Map<number, string[]> }

test(`after each of ${appends} random appends, every match’s view row is what the core gives for its kept records, and a rebuild gives back the same view`, async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000)
  const seed = fixedSeed ?? Math.floor(Math.random() * 2 ** 31)
  testInfo.annotations.push({ type: 'seed', description: String(seed) })
  console.log(`storage-matches-random seed: ${seed}`)
  const random = generator(seed)
  const harness = new StorageHarness(page)
  await harness.open()

  const matches: Match[] = []
  // Made and not yet appended: delivered later, out of order.
  let heldBack: Made[] = []
  // Every record appended so far, for repeats.
  const appended: Made[] = []

  // What one step makes: a new match (its player and match record), or one
  // to three scores, each a save, correction or clear of a random game,
  // sometimes past best of or naming nothing or only some of what came
  // before for that game.
  async function makeStep(): Promise<Made[]> {
    if (matches.length === 0 || random.chance(0.12)) {
      const [player] = await harness.makeRecords([{ kind: 'player' }])
      const bestOf = random.pick([1, 3, 5, 7, 7, 9])
      const terms = random.chance(0.05) ? 'a3000201050201' : undefined
      const [match] = await harness.makeRecords([
        { kind: 'match', opponent: player.player!, bestOf, rated: random.chance(0.5), terms },
      ])
      matches.push({ id: match.id, bestOf: terms === undefined ? bestOf : 255, scores: new Map() })
      return [player, match]
    }
    const specs: Spec[] = []
    const count = random.chance(0.7) ? 1 : random.int(3) + 1
    for (let i = 0; i < count; i++) {
      const match = random.pick(matches)
      const slot = random.chance(0.05) ? match.bestOf + 1 : random.int(Math.min(match.bestOf, 9)) + 1
      const earlier = match.scores.get(slot) ?? []
      const mode = random.pick(['all', 'all', 'all', 'none', 'some', 'other'] as const)
      const replaces =
        mode === 'all'
          ? earlier
          : mode === 'none'
            ? []
            : mode === 'some'
              ? earlier.filter(() => random.chance(0.5))
              : [...(random.pick(matches).scores.get(random.int(3) + 1) ?? [])]
      const score: [number, number] | null = random.chance(0.15)
        ? null
        : random.pick([
            [11, random.int(10)],
            [random.int(10), 11],
            [12, 10],
            [10 + random.int(5), 12 + random.int(5)],
          ] as [number, number][])
      specs.push({ kind: 'score', match: match.id, slot, score, replaces })
    }
    const made = await harness.makeRecords(specs)
    made.forEach((score, i) => {
      const spec = specs[i] as Extract<Spec, { kind: 'score' }>
      const match = matches.find(({ id }) => id === spec.match)!
      match.scores.set(spec.slot, [...(match.scores.get(spec.slot) ?? []), score.id])
    })
    return made
  }

  for (let step = 1; step <= appends; step++) {
    const made = await makeStep()
    let batch: Made[]
    if (random.chance(0.1)) {
      // Held back: something else goes in now.
      heldBack.push(...made)
      batch = appended.length > 0 ? [random.pick(appended)] : []
    } else {
      batch = made
    }
    if (random.chance(0.1) && heldBack.length > 0) {
      batch = random.shuffle([...batch, ...heldBack])
      heldBack = []
    }
    // A repeat: a record kept already, appended again with others.
    if (random.chance(0.08) && appended.length > 0) {
      batch = random.shuffle([...batch, random.pick(appended)])
    }
    if (batch.length === 0) continue

    const result = await harness.append(batch.map(({ record }) => record))
    expect(result, `seed ${seed}, append ${step}`).toEqual({ ok: true })
    appended.push(...batch)

    const [views, expected, journal] = await Promise.all([
      harness.views(),
      harness.expectedViews(),
      harness.readStore('journal') as Promise<[number, { id: string }][]>,
    ])
    const seqs = new Map(journal.map(([seq, { id }]) => [id, seq]))
    const wanted = Object.fromEntries(
      Object.entries(expected)
        .filter(([, state]) => state !== null)
        .map(([id, state]) => [id, { ...state!, seq: seqs.get(id)! } satisfies View]),
    )
    expect(views, `seed ${seed}, after append ${step}`).toEqual(wanted)

    if (step % reloadEvery === 0) await harness.reload()
  }

  // Everything held back goes in, then the view is damaged and rebuilt: a
  // row missing, a row with other games and journal number, the rest left
  // or damaged at random, and a row no record gives.
  if (heldBack.length > 0) {
    expect(await harness.append(heldBack.map(({ record }) => record))).toEqual({ ok: true })
  }
  const before = await harness.readStore('matches')
  const rows = random.shuffle(before as [string, View][])
  for (const [i, [id, row]] of rows.entries()) {
    const damage = i === 0 ? 'missing' : i === 1 ? 'wrong' : random.pick(['missing', 'wrong', 'right'])
    if (damage === 'missing') await harness.deleteEntry('matches', id)
    if (damage === 'wrong') {
      await harness.putEntry('matches', id, { ...row, games: row.games.slice(1), seq: row.seq + 1 })
    }
  }
  await harness.putEntry('matches', 'cd'.repeat(32), { stale: true })
  expect(await harness.rebuildViews(), `seed ${seed}`).toEqual({ ok: true })
  expect(await harness.readStore('matches'), `seed ${seed}, rebuilt`).toEqual(before)
  // Every match made has a row by now.
  expect(before.map(([id]) => id).sort(), `seed ${seed}`).toEqual(matches.map(({ id }) => id).sort())
})
