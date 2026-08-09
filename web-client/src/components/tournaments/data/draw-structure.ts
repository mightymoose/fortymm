// The whole **round-robin-then-knockout draw structure**, derived from the eight numbers
// a director can set (#1320). Pool count, pool sizes, qualifiers, the bracket, the byes,
// the pool-match total, the source sentence under each row, and the three notices —
// disagreement, uneven, impossible.
//
// **This module renders nothing and fetches nothing.** It is a pure function, and that is
// load-bearing rather than tidy: the tab recomputes on every keystroke, so the number a
// director reads must never lag the input that produced it (ADR
// 20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors).
//
// **The same arithmetic also runs in Python, and neither side is generated from the
// other.** The API owns the refusals, because a rule enforced only in React is not
// enforced — `ios/` and the MCP server write events too. What ties the two copies together
// is one table of vectors, asserted on both sides with identical inputs and identical
// expected numbers (`./draw-structure.test.ts`). A reviewer should read the two tables
// side by side before reading either implementation. **Anything added here that the
// vectors do not pin is drift waiting to happen**, which is why the result carries only
// the fields the tab actually reads.
//
// The spec is `docs/designs/rr-then-ko-draw-structure/README.md` — its "The derivation"
// section for the maths, its "Row copy" and "Impossible" sections for the strings. The
// strings are **verbatim**, including the `÷` and `·` glyphs and including
// `1 pool reservations`: this module does not pluralise copy the reference does not
// pluralise, because a silent improvement here reds the Python vectors later and the diff
// looks like a Python bug.

/** The knockout the automatic qualifier count aims at. **A constant, not stored state**
 * (ADR 20260808-a-structural-setting-is-owned-by-the-director-or-derived-by-the-system):
 * nothing in the reference writes it, so no UI exposes it. A director who wants a
 * different bracket sets the qualifiers themselves, which is a setting they own. */
export const TARGET_BRACKET_SIZE = 8

/** Who a structural setting belongs to: the system derived it, or the director typed it.
 * The row's `Automatic` / `Yours` badge is this, and nothing else. */
export type SettingOwnership = 'automatic' | 'manual'

/** One setting row's provenance: who owns the number, and the one line under it saying
 * where the number came from. The sentence is derived here rather than in the row, so the
 * copy cannot fork across three components that each know a little of the derivation. */
export interface SettingSource {
  ownership: SettingOwnership
  sentence: string
}

/** The provenance of all three numeric settings. Membership is not here: it has no
 * number, so it is not derived — the row reads its mode straight off the event. */
export interface DrawStructureSources {
  poolCount: SettingSource
  poolSize: SettingSource
  qualifiers: SettingSource
}

/** A run of same-sized pools, for the uneven notice's tally (`2 pools of 6 · 2 pools of
 * 5`). Largest size first. */
export interface PoolSizeTally {
  /** How many pools hold this many players. */
  pools: number
  /** How many players those pools hold. */
  size: number
}

/**
 * The director's two manual numbers do not multiply out to their field.
 *
 * **This is not an error and it is not corrected.** Both numbers were typed on purpose, so
 * the app states the arithmetic and offers fixes rather than quietly reshaping one of them
 * — hence `direction` and `count` instead of a signed difference nobody would read aloud.
 *
 * Only the numbers live here. The panel's title, body and three fixes are the renderer's,
 * because the fixes are buttons and a button is not a derivation.
 */
export interface DrawStructureDisagreement {
  /** The manual pool count, as the derivation used it. */
  poolCount: number
  /** The manual pool size, as the derivation used it. */
  poolSize: number
  /** `poolCount * poolSize` — the seats the structure actually has. */
  seats: number
  /** The field the preview is derived against. */
  fieldSize: number
  /** Which way the shortfall runs: more players than seats, or more seats than players. */
  direction: 'unseated' | 'empty-seats'
  /** How many entrants have nowhere to go, or how many seats would be empty. Always
   * positive — the direction carries the sign. */
  count: number
}

/** Which of the three impossible competitions a configuration produces. */
export type ImpossibleProblemKind = 'pool' | 'bracket' | 'qualifier'

/** A competition that cannot be played, in the words the panel shows. The API refuses the
 * same three conditions in its own, longer copy (`api/app/draws.py`); this is the client's
 * shorter version, because the panel also offers fixes and the API cannot. */
export interface ImpossibleProblem {
  kind: ImpossibleProblemKind
  title: string
  body: string
}

/** The eight inputs. Every one of them is stated at each call site and in every vector —
 * there is no defaults builder, because the Python side transcribes this table by hand and
 * a hidden default is a guess waiting to be made wrong. */
export interface DrawStructureOptions {
  /** The field the preview derives against: the event's cap, or the uncapped default. */
  previewFieldSize: number
  /** How many pool rows the event already has — today's behaviour for the pool count. */
  poolReservationCount: number
  poolCountMode: SettingOwnership
  manualPoolCount: number | null
  poolSizeMode: SettingOwnership
  manualPoolSize: number | null
  qualifiersMode: SettingOwnership
  manualQualifiers: number | null
}

/** Everything the Draw structure tab renders, derived once. */
export interface DrawStructure {
  poolCount: number
  /** One entry per pool, in pool order — **not** a single size, because the pools are
   * routinely unequal and the uneven case is a first-class state, not an edge. */
  poolSizes: number[]
  qualifiersPerPool: number
  /** `poolCount * qualifiersPerPool`: how many players come out of the pool stage. */
  totalQualifiers: number
  /** The knockout's entry list. The same number as `totalQualifiers` by construction —
   * they are two different questions with one answer, and both are named because the tab
   * asks both. */
  knockoutBracketSize: number
  firstRoundByes: number
  /** Every all-play-all match the pool stage plays, across all pools. */
  poolMatchCount: number
  sources: DrawStructureSources
  // ⚠️ The next three are reported **independently**, and more than one can be non-empty
  // at once — a pool of one is routinely also an uneven split. The reference shows only
  // ONE panel at a time (impossible, then disagreement, then uneven), and that precedence
  // belongs to whatever renders them. It is not encoded here: a derivation that suppressed
  // the uneven tally because a pool was impossible would be deciding a layout question.
  /** `null` when the numbers agree, or when only one of them is the director's. */
  disagreement: DrawStructureDisagreement | null
  /** The size tally, largest first, or `null` when every pool is the same size. */
  unevenDistribution: PoolSizeTally[] | null
  /** **At most one problem**, and always the first in `pool` → `bracket` → `qualifier`
   * order. One impossible competition is one thing to fix; listing the two further
   * conditions that a pool of one also trips would bury it. */
  impossibleProblems: ImpossibleProblem[]
}

/** `Pool A`, `Pool B`, … and past `Pool Z` the spreadsheet's `AA`, so a hundred-pool field
 * names its pools instead of printing punctuation. */
export function poolLetter(index: number): string {
  let letters = ''
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    letters = String.fromCharCode(65 + (n % 26)) + letters
  }
  return letters
}

/** The README's `2 ^ ceil(log2(n))`, computed by doubling. Same answer, minus the chance
 * that a float `log2` puts an exact power of two on the wrong side of a `ceil`. */
function nextPowerOfTwo(n: number): number {
  let size = 1
  while (size < n) size *= 2
  return size
}

/** The `max(1, …)` the README puts on every director-supplied number. A zero or a negative
 * is not a smaller structure, it is no structure — and every sentence that reports the
 * number reports **this** value, so the copy explains the division that actually happened.
 */
const atLeastOne = (value: number) => Math.max(1, value)

/** The balanced split: `base = floor(field / count)`, and the remainder goes to the
 * EARLIEST pools. 22 across 4 is `6, 6, 5, 5`. */
function balancedSizes(fieldSize: number, poolCount: number): number[] {
  const base = Math.floor(fieldSize / poolCount)
  const extra = fieldSize % poolCount
  return Array.from({ length: poolCount }, (_, i) => base + (i < extra ? 1 : 0))
}

/**
 * The **greedy** fill, used when the director set the pool size but not the pool count:
 * each pool takes the target in turn and the last pool takes what is left.
 *
 * ⚠️ **This is deliberately not a balanced split, and must not be "fixed" into one.** 41
 * players in pools of 5 gives `5,5,5,5,5,5,5,5,1` — and that pool of one is then an
 * impossible competition the director is told about. Rebalancing to `5,5,5,5,5,5,5,4,4`
 * would silently reshape a number they typed, which is the exact behaviour #1320 exists to
 * remove: the app states the consequence of the input, it does not edit the input.
 */
function greedySizes(fieldSize: number, poolCount: number, poolSize: number): number[] {
  let remaining = fieldSize
  return Array.from({ length: poolCount }, () => {
    const take = Math.min(poolSize, remaining)
    remaining -= take
    return take
  })
}

/** The size tally the uneven notice reads out, largest pool first. */
function tallySizes(sizes: number[]): PoolSizeTally[] {
  const counts = new Map<number, number>()
  for (const size of sizes) counts.set(size, (counts.get(size) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([a], [b]) => b - a)
    .map(([size, pools]) => ({ pools, size }))
}

/**
 * Derive the whole draw structure from the eight inputs.
 *
 * **A mode of `manual` with no number is automatic.** A director who clears the input has
 * not set anything, and the row must go on showing a real number rather than a blank or a
 * one. The reported ownership is therefore the *effective* one, so the `Yours` badge and
 * the source sentence can never disagree with each other.
 */
export function deriveDrawStructure(options: DrawStructureOptions): DrawStructure {
  const {
    previewFieldSize: fieldSize,
    poolReservationCount,
    poolCountMode,
    manualPoolCount,
    poolSizeMode,
    manualPoolSize,
    qualifiersMode,
    manualQualifiers,
  } = options

  const setCount = poolCountMode === 'manual' && manualPoolCount !== null
  const setSize = poolSizeMode === 'manual' && manualPoolSize !== null
  const setQualifiers = qualifiersMode === 'manual' && manualQualifiers !== null

  const targetSize = setSize ? atLeastOne(manualPoolSize) : null

  // Pool count: the director's, else derived from their pool size, else today's behaviour
  // — one reservation row is one pool.
  const poolCount = setCount
    ? atLeastOne(manualPoolCount)
    : targetSize !== null
      ? atLeastOne(Math.ceil(fieldSize / targetSize))
      : atLeastOne(poolReservationCount)

  // Pool sizes. Both manual means both numbers stand, product be damned — that standoff is
  // reported as a disagreement below, never resolved by moving one of them.
  const poolSizes =
    targetSize === null
      ? balancedSizes(fieldSize, poolCount)
      : setCount
        ? Array.from({ length: poolCount }, () => targetSize)
        : greedySizes(fieldSize, poolCount, targetSize)

  const smallestPool = Math.min(...poolSizes)
  const largestPool = Math.max(...poolSizes)

  const qualifiersPerPool = setQualifiers
    ? atLeastOne(manualQualifiers)
    : atLeastOne(Math.ceil(TARGET_BRACKET_SIZE / poolCount))

  const knockoutBracketSize = poolCount * qualifiersPerPool
  // `max(2, …)` is what makes a one-player knockout report ONE bye rather than none: the
  // smallest bracket that can be drawn holds two, so the missing player is a bye.
  const firstRoundByes = nextPowerOfTwo(Math.max(2, knockoutBracketSize)) - knockoutBracketSize
  const poolMatchCount = poolSizes.reduce((total, n) => total + (n * (n - 1)) / 2, 0)

  const seats = poolCount * (targetSize ?? 0)
  const conflict = setCount && setSize && seats !== fieldSize
  const disagreement: DrawStructureDisagreement | null =
    conflict && targetSize !== null
      ? {
          poolCount,
          poolSize: targetSize,
          seats,
          fieldSize,
          direction: fieldSize > seats ? 'unseated' : 'empty-seats',
          count: Math.abs(fieldSize - seats),
        }
      : null

  // The `not conflict` guard mirrors the README and the Python. No input can distinguish
  // it: a disagreement needs both modes manual, and both manual gives every pool the same
  // size, so `min === max` already. It stays because the two implementations must read the
  // same, not because a vector reaches it.
  const unevenDistribution =
    !conflict && smallestPool !== largestPool ? tallySizes(poolSizes) : null

  return {
    poolCount,
    poolSizes,
    qualifiersPerPool,
    totalQualifiers: knockoutBracketSize,
    knockoutBracketSize,
    firstRoundByes,
    poolMatchCount,
    sources: {
      poolCount: {
        ownership: setCount ? 'manual' : 'automatic',
        sentence: setCount
          ? 'You set this. Each pool also gets a reservation.'
          : targetSize !== null
            ? `${fieldSize} players ÷ about ${targetSize} per pool`
            : `${poolCount} pool reservations · today's behaviour`,
      },
      poolSize: {
        ownership: setSize ? 'manual' : 'automatic',
        sentence: setSize
          ? setCount
            ? 'You set this.'
            : 'You set the target. We derived the pool count.'
          : `${fieldSize} players ÷ ${poolCount} pools`,
      },
      qualifiers: {
        ownership: setQualifiers ? 'manual' : 'automatic',
        sentence: setQualifiers
          ? 'You set this.'
          : `Aiming at an ${TARGET_BRACKET_SIZE}-player knockout across ${poolCount} pools.`,
      },
    },
    disagreement,
    unevenDistribution,
    impossibleProblems: impossibleProblemsFor({
      poolSizes,
      smallestPool,
      knockoutBracketSize,
      qualifiersPerPool,
    }),
  }
}

/**
 * The three impossible competitions, **tested in order, first hit only**.
 *
 * The order is not arbitrary. A pool of one trips the qualifier rule too, and a field of
 * one trips all three — but "Pool C would have one player" is the fact the director can
 * act on, and the other two are echoes of it. Reporting the echoes alongside it would make
 * one mistake look like three.
 */
function impossibleProblemsFor({
  poolSizes,
  smallestPool,
  knockoutBracketSize,
  qualifiersPerPool,
}: {
  poolSizes: number[]
  smallestPool: number
  knockoutBracketSize: number
  qualifiersPerPool: number
}): ImpossibleProblem[] {
  // 1. A pool nobody can play in. Named by the FIRST such pool, because that is the one a
  //    director looking down the preview will see first.
  const emptyIndex = poolSizes.findIndex((size) => size < 2)
  if (emptyIndex !== -1) {
    const size = poolSizes[emptyIndex]
    return [
      {
        kind: 'pool',
        title: `Pool ${poolLetter(emptyIndex)} would have ${size === 1 ? 'one player' : 'no players'}`,
        body: 'They would have nobody to play. Use fewer pools or raise the player limit.',
      },
    ]
  }

  // 2. A knockout of one. Reachable only from one pool taking one qualifier, and the
  //    winner of that pool would be handed a title without playing for it.
  if (knockoutBracketSize < 2) {
    return [
      {
        kind: 'bracket',
        title: 'The knockout would have one player',
        body: 'One player has nobody to play. Take more qualifiers or run more pools.',
      },
    ]
  }

  // 3. More qualifiers than the smallest pool holds — the pool would advance players it
  //    does not have.
  if (qualifiersPerPool > smallestPool) {
    return [
      {
        kind: 'qualifier',
        // ⚠️ A **right single quote** (`U+2019`) in `can’t`, like every other apostrophe
        // the reference writes. The one exception is `today's behaviour` above, which the
        // reference spells with a straight `U+0027`. Both are transcribed, neither is
        // normalised: the README says so out loud, and a Python twin transcribing this
        // table has to land on the same glyph.
        title: `You can’t take ${qualifiersPerPool} qualifiers from a pool of ${smallestPool}`,
        body: `Take ${smallestPool} or fewer, or make the smallest pool bigger.`,
      },
    ]
  }

  return []
}
