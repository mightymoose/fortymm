// The whole **round-robin-then-knockout draw structure**, derived from the seven numbers
// a director can set (#1320). Group count, group sizes, qualifiers, the bracket, the byes,
// the group-match total, the source sentence under each row, and the three notices —
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
// The starting point is `docs/designs/rr-then-ko-draw-structure/README.md` — its "The
// derivation" section for the maths, its "Row copy" and "Impossible" sections for the
// strings — but **not every string here is the reference's any more**. The automatic
// group count departs from it (#1386): the count derives from `DEFAULT_GROUP_SIZE`, not
// from the reservation rows, and the two group-count sentences are ours. The README's
// "What the reference does not settle" section records the divergence. Reference copy
// this module keeps is kept **verbatim**, `÷` and `·` glyphs included: a silent
// improvement here reds the Python vectors later and the diff looks like a Python bug.
//
// ⚠️ **`groupLetter` is asserted against `api/tests/test_draws.py`**, which pins the
// identical seven `(position, label)` pairs and carries a comment pointing back at this
// file — the mutual citation is deliberate (ticket #1369), so the base-26 carry cannot
// drift between the two implementations without both test suites failing.

/** The knockout the automatic qualifier count aims at. **A constant, not stored state**
 * (ADR 20260808-a-structural-setting-is-owned-by-the-director-or-derived-by-the-system):
 * nothing in the reference writes it, so no UI exposes it. A director who wants a
 * different bracket sets the qualifiers themselves, which is a setting they own. */
export const TARGET_BRACKET_SIZE = 8

/** The group size the automatic group count divides by — `max(1, ceil(field / 5))`, with
 * the sizes then balanced across that count. **A count divisor, not a size target**: a
 * field of 16 gives four groups of four, where filling to five greedily would give
 * `5, 5, 5, 1` and a group of one is a competition nobody can play (#1370 decision 1). A
 * director who *types* a five keeps the greedy meaning — a typed number is theirs, and
 * the app states its consequence rather than reshaping it. **A constant, not stored
 * state**, like the bracket target above.
 *
 * ⚠️ Duplicated in `api/app/draw_structure.py`, and the shared vectors pin both copies. */
export const DEFAULT_GROUP_SIZE = 5

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
  groupCount: SettingSource
  groupSize: SettingSource
  qualifiers: SettingSource
}

/** A run of same-sized groups, for the uneven notice's tally (`2 groups of 6 · 2 groups of
 * 5`). Largest size first. */
export interface GroupSizeTally {
  /** How many groups hold this many players. */
  groups: number
  /** How many players those groups hold. */
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
  /** The manual group count, as the derivation used it. */
  groupCount: number
  /** The manual group size, as the derivation used it. */
  groupSize: number
  /** `groupCount * groupSize` — the seats the structure actually has. */
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
export type ImpossibleProblemKind = 'group' | 'bracket' | 'qualifier'

/** A competition that cannot be played, in the words the panel shows. The API refuses the
 * same three conditions in its own, longer copy (`api/app/draws.py`); this is the client's
 * shorter version, because the panel also offers fixes and the API cannot. */
export interface ImpossibleProblem {
  kind: ImpossibleProblemKind
  title: string
  body: string
}

/** The seven inputs. Every one of them is stated at each call site and in every vector —
 * there is no defaults builder, because the Python side transcribes this table by hand and
 * a hidden default is a guess waiting to be made wrong.
 *
 * The reservation count is deliberately **not** here (#1386): the automatic group count
 * derives from `DEFAULT_GROUP_SIZE`, so adding or removing a reservation changes no
 * derived number. */
export interface DrawStructureOptions {
  /** The field the preview derives against: the event's cap, or the uncapped default. */
  previewFieldSize: number
  groupCountMode: SettingOwnership
  manualGroupCount: number | null
  groupSizeMode: SettingOwnership
  manualGroupSize: number | null
  qualifiersMode: SettingOwnership
  manualQualifiers: number | null
}

/** Everything the Draw structure tab renders, derived once. */
export interface DrawStructure {
  groupCount: number
  /** One entry per group, in group order — **not** a single size, because the groups are
   * routinely unequal and the uneven case is a first-class state, not an edge. */
  groupSizes: number[]
  qualifiersPerGroup: number
  /** `groupCount * qualifiersPerGroup`: how many players come out of the group stage. */
  totalQualifiers: number
  /** The knockout's entry list. The same number as `totalQualifiers` by construction —
   * they are two different questions with one answer, and both are named because the tab
   * asks both. */
  knockoutBracketSize: number
  firstRoundByes: number
  /** Every all-play-all match the group stage plays, across all groups. */
  groupMatchCount: number
  sources: DrawStructureSources
  // ⚠️ The next three are reported **independently**, and more than one can be non-empty
  // at once — a group of one is routinely also an uneven split. The reference shows only
  // ONE panel at a time (impossible, then disagreement, then uneven), and that precedence
  // belongs to whatever renders them. It is not encoded here: a derivation that suppressed
  // the uneven tally because a group was impossible would be deciding a layout question.
  /** `null` when the numbers agree, or when only one of them is the director's. */
  disagreement: DrawStructureDisagreement | null
  /** The size tally, largest first, or `null` when every group is the same size. */
  unevenDistribution: GroupSizeTally[] | null
  /** **At most one problem**, and always the first in `group` → `bracket` → `qualifier`
   * order. One impossible competition is one thing to fix; listing the two further
   * conditions that a group of one also trips would bury it. */
  impossibleProblems: ImpossibleProblem[]
}

/** `Group A`, `Group B`, … and past `Group Z` the spreadsheet's `AA`, so a hundred-group
 * field names its groups instead of printing punctuation.
 *
 * ⚠️ **Pinned against `api/tests/test_draws.py`** — the identical seven `(position,
 * label)` pairs (0→"A", 1→"B", 25→"Z", 26→"AA", 27→"AB", 51→"AZ", 52→"BA") are asserted
 * there too, with a comment pointing back at this file. Positions 26 and 52 are the ones
 * worth keeping: the carry is `n // 26 - 1`, and a naive `n // 26` agrees for 0–25 then
 * silently diverges. */
export function groupLetter(index: number): string {
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
 * EARLIEST groups. 22 across 4 is `6, 6, 5, 5`. */
function balancedSizes(fieldSize: number, groupCount: number): number[] {
  const base = Math.floor(fieldSize / groupCount)
  const extra = fieldSize % groupCount
  return Array.from({ length: groupCount }, (_, i) => base + (i < extra ? 1 : 0))
}

/**
 * The **greedy** fill, used when the director set the group size but not the group count:
 * each group takes the target in turn and the last group takes what is left.
 *
 * ⚠️ **This is deliberately not a balanced split, and must not be "fixed" into one.** 41
 * players in groups of 5 gives `5,5,5,5,5,5,5,5,1` — and that group of one is then an
 * impossible competition the director is told about. Rebalancing to `5,5,5,5,5,5,5,4,4`
 * would silently reshape a number they typed, which is the exact behaviour #1320 exists to
 * remove: the app states the consequence of the input, it does not edit the input.
 */
function greedySizes(fieldSize: number, groupCount: number, groupSize: number): number[] {
  let remaining = fieldSize
  return Array.from({ length: groupCount }, () => {
    const take = Math.min(groupSize, remaining)
    remaining -= take
    return take
  })
}

/** The size tally the uneven notice reads out, largest group first. */
function tallySizes(sizes: number[]): GroupSizeTally[] {
  const counts = new Map<number, number>()
  for (const size of sizes) counts.set(size, (counts.get(size) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([a], [b]) => b - a)
    .map(([size, groups]) => ({ groups, size }))
}

/**
 * Derive the whole draw structure from the seven inputs.
 *
 * **A mode of `manual` with no number is automatic.** A director who clears the input has
 * not set anything, and the row must go on showing a real number rather than a blank or a
 * one. The reported ownership is therefore the *effective* one, so the `Yours` badge and
 * the source sentence can never disagree with each other.
 */
export function deriveDrawStructure(options: DrawStructureOptions): DrawStructure {
  const {
    previewFieldSize: fieldSize,
    groupCountMode,
    manualGroupCount,
    groupSizeMode,
    manualGroupSize,
    qualifiersMode,
    manualQualifiers,
  } = options

  const setCount = groupCountMode === 'manual' && manualGroupCount !== null
  const setSize = groupSizeMode === 'manual' && manualGroupSize !== null
  const setQualifiers = qualifiersMode === 'manual' && manualQualifiers !== null

  const targetSize = setSize ? atLeastOne(manualGroupSize) : null

  // Group count: the director's, else derived from a size — theirs when they typed one,
  // the default divisor otherwise. One shape, one fallback chain. Named once so the
  // sentence below reports the same divisor the arithmetic used, structurally.
  const countDivisor = targetSize ?? DEFAULT_GROUP_SIZE
  const groupCount = setCount
    ? atLeastOne(manualGroupCount)
    : atLeastOne(Math.ceil(fieldSize / countDivisor))

  // Group sizes. Both manual means both numbers stand, product be damned — that standoff
  // is reported as a disagreement below, never resolved by moving one of them.
  const groupSizes =
    targetSize === null
      ? balancedSizes(fieldSize, groupCount)
      : setCount
        ? Array.from({ length: groupCount }, () => targetSize)
        : greedySizes(fieldSize, groupCount, targetSize)

  const smallestGroup = Math.min(...groupSizes)
  const largestGroup = Math.max(...groupSizes)

  const qualifiersPerGroup = setQualifiers
    ? atLeastOne(manualQualifiers)
    : atLeastOne(Math.ceil(TARGET_BRACKET_SIZE / groupCount))

  const knockoutBracketSize = groupCount * qualifiersPerGroup
  // `max(2, …)` is what makes a one-player knockout report ONE bye rather than none: the
  // smallest bracket that can be drawn holds two, so the missing player is a bye.
  const firstRoundByes = nextPowerOfTwo(Math.max(2, knockoutBracketSize)) - knockoutBracketSize
  const groupMatchCount = groupSizes.reduce((total, n) => total + (n * (n - 1)) / 2, 0)

  const seats = groupCount * (targetSize ?? 0)
  const conflict = setCount && setSize && seats !== fieldSize
  const disagreement: DrawStructureDisagreement | null =
    conflict && targetSize !== null
      ? {
          groupCount,
          groupSize: targetSize,
          seats,
          fieldSize,
          direction: fieldSize > seats ? 'unseated' : 'empty-seats',
          count: Math.abs(fieldSize - seats),
        }
      : null

  // The `not conflict` guard mirrors the README. No input can distinguish it: a
  // disagreement needs both modes manual, and both manual gives every group the same
  // size, so `min === max` already. It stays to follow the README's shape, not because a
  // vector reaches it. (The Python twin carries no uneven logic at all — the tally is
  // client-only, outside the shared subset.)
  const unevenDistribution =
    !conflict && smallestGroup !== largestGroup ? tallySizes(groupSizes) : null

  return {
    groupCount,
    groupSizes,
    qualifiersPerGroup,
    totalQualifiers: knockoutBracketSize,
    knockoutBracketSize,
    firstRoundByes,
    groupMatchCount,
    sources: {
      groupCount: {
        ownership: setCount ? 'manual' : 'automatic',
        // One template for the whole automatic arm: the division that happened is
        // `field / (typed size ?? default)`, so the sentence reports whichever divisor
        // was actually used (#1370 decision 3).
        sentence: setCount
          ? 'You set this.'
          : `${fieldSize} players ÷ about ${countDivisor} per group`,
      },
      groupSize: {
        ownership: setSize ? 'manual' : 'automatic',
        sentence: setSize
          ? setCount
            ? 'You set this.'
            : 'You set the target. We derived the group count.'
          : `${fieldSize} players ÷ ${groupCount} groups`,
      },
      qualifiers: {
        ownership: setQualifiers ? 'manual' : 'automatic',
        sentence: setQualifiers
          ? 'You set this.'
          : `Aiming at an ${TARGET_BRACKET_SIZE}-player knockout across ${groupCount} groups.`,
      },
    },
    disagreement,
    unevenDistribution,
    impossibleProblems: impossibleProblemsFor({
      groupSizes,
      smallestGroup,
      knockoutBracketSize,
      qualifiersPerGroup,
    }),
  }
}

/**
 * The three impossible competitions, **tested in order, first hit only**.
 *
 * The order is not arbitrary. A group of one trips the qualifier rule too, and a field of
 * one trips all three — but "Group C would have one player" is the fact the director can
 * act on, and the other two are echoes of it. Reporting the echoes alongside it would make
 * one mistake look like three.
 */
function impossibleProblemsFor({
  groupSizes,
  smallestGroup,
  knockoutBracketSize,
  qualifiersPerGroup,
}: {
  groupSizes: number[]
  smallestGroup: number
  knockoutBracketSize: number
  qualifiersPerGroup: number
}): ImpossibleProblem[] {
  // 1. A group nobody can play in. Named by the FIRST such group, because that is the one
  //    a director looking down the preview will see first.
  //
  //    Inlined `Group ${groupLetter(...)}` rather than `./draw`'s `groupLabel` on
  //    purpose: `./draw` imports this module (`groupLetter`), so calling back into it
  //    from here would be a cycle. This is the one call site `groupLabel` cannot
  //    replace for that reason (see `./standings.ts`, which uses `groupLabel` because it
  //    only reaches this module transitively, never the reverse).
  const emptyIndex = groupSizes.findIndex((size) => size < 2)
  if (emptyIndex !== -1) {
    const size = groupSizes[emptyIndex]
    return [
      {
        kind: 'group',
        title: `Group ${groupLetter(emptyIndex)} would have ${size === 1 ? 'one player' : 'no players'}`,
        body: 'They would have nobody to play. Use fewer groups or raise the player limit.',
      },
    ]
  }

  // 2. A knockout of one. Reachable only from one group taking one qualifier, and the
  //    winner of that group would be handed a title without playing for it.
  if (knockoutBracketSize < 2) {
    return [
      {
        kind: 'bracket',
        title: 'The knockout would have one player',
        body: 'One player has nobody to play. Take more qualifiers or run more groups.',
      },
    ]
  }

  // 3. More qualifiers than the smallest group holds — the group would advance players it
  //    does not have.
  if (qualifiersPerGroup > smallestGroup) {
    return [
      {
        kind: 'qualifier',
        title: `You can't take ${qualifiersPerGroup} qualifiers from a group of ${smallestGroup}`,
        body: `Take ${smallestGroup} or fewer, or make the smallest group bigger.`,
      },
    ]
  }

  return []
}
