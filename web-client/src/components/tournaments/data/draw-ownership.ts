// **Who owns each of a round-robin-then-knockout draw's four structural settings**, as the
// event stores it — the wire's `draw_structure` object (ADR
// 20260808-a-structural-setting-is-owned-by-the-director-or-derived-by-the-system).
//
// ⚠️ **This is not `./draw-structure`, and the two must not be confused.** That module
// *derives* the draw — the pool count, the sizes, the qualifiers, the source sentences and
// the three notices. This one is the small record of **who owns what**, which is the only
// part of it the server keeps. One is an input to the other, and they are named apart on
// purpose: `DrawStructure` is the derived answer, `DrawOwnership` is the stored question.
//
// The domain field is `TournamentEvent.drawOwnership` while the wire key is
// `draw_structure`, the same rename `match_settings` → `match` already makes: the client
// names a value for what it holds, and the two mappers below are the one place the two
// vocabularies meet.
//
// **A manual number is kept while its mode is `automatic`** (the ADR, and the API's own
// comment on `DrawStructure`). `Use automatic` is therefore not destructive: the
// director's number is remembered, and taking the setting back returns it rather than an
// empty box.

import { z } from 'zod'

import type { components } from '@/api/schema'
import { PLAYERS_MAX } from './event-validation'

type ApiDrawStructure = components['schemas']['DrawStructure']

/** How entrants reach their pools. Ownership again, but its two values are named for what
 * they DO rather than for who chose them (the API's `PoolMembershipMode`): `snake` is the
 * 1, 2, 3, 3, 2, 1 deal `_snake()` already performs on every cut, and `manual` is the
 * director placing entrants themselves once registration closes. */
export type PoolMembershipMode = 'snake' | 'manual'

/** The ceiling on a manual pool count or pool size — the server's
 * `MAX_MANUAL_POOL_DIMENSION`, which is `MAX_EVENT_PLAYERS`, which is the number this
 * client already states as `PLAYERS_MAX`. Read off that constant rather than re-typed, so
 * the two bounds cannot come apart: a draw of more pools than the field can hold players
 * is not a draw. */
export const MANUAL_POOL_DIMENSION_MAX = PLAYERS_MAX

/** The floor on every manual number: the server's `ge=1`, and the reason a cleared box
 * must send `null`. **A `0` is a 422**, not a smaller structure — no pools is not a draw —
 * and `Number('')` is `0`, which is precisely how a cleared box authors one. */
export const MANUAL_MIN = 1

/** A manual pool dimension: a whole number the server's `ge=1, le=512` admits, or `null`
 * for a box the director has cleared. `null` is a real state and not an error — the
 * derivation reads a manual mode with no number as automatic — so it is never coerced. */
const manualDimensionSchema = z
  .number()
  .int()
  .min(MANUAL_MIN)
  .max(MANUAL_POOL_DIMENSION_MAX)
  .nullable()

/**
 * The stored ownership record. Mirrors the API's `DrawStructure` field for field, in this
 * client's vocabulary, and **carries its bounds**: every number that crosses this schema
 * is one the server's `ManualPoolCount` / `ManualPoolSize` would accept.
 *
 * There is no manual *qualifier* number here, and that absence is the wire's: the
 * qualifier count's value is the event's own `qualifiersPerPool`, which every `rr-then-ko`
 * event already carries, and `qualifiersMode` says whether anybody should read it. A
 * second copy would be a field and its own derivation in one object.
 */
export const drawOwnershipSchema = z.object({
  poolCountMode: z.enum(['automatic', 'manual']),
  manualPoolCount: manualDimensionSchema,
  poolSizeMode: z.enum(['automatic', 'manual']),
  manualPoolSize: manualDimensionSchema,
  qualifiersMode: z.enum(['automatic', 'manual']),
  membershipMode: z.enum(['snake', 'manual']),
})

export type DrawOwnership = z.infer<typeof drawOwnershipSchema>

/**
 * What an `rr-then-ko` event holds before a director takes any setting for themselves:
 * every mode the system's, no manual numbers, membership by snake. It is also what every
 * event that predates the Draw structure tab reads back as — the ADR's "an event that sets
 * nothing behaves exactly as it does today".
 *
 * ⚠️ **A function, not a constant.** `as const` gives readonly modifiers TypeScript does
 * **not** check on assignment, so one shared object handed to every event would be one
 * object every event's toggle rewrote. A fresh record per event is also what the database
 * holds. (The wire-side twin, `EVERY_SETTING_AUTOMATIC` in the mock factory, states the
 * same thing about itself and is spread at every use site.)
 */
export function everySettingAutomatic(): DrawOwnership {
  return {
    poolCountMode: 'automatic',
    manualPoolCount: null,
    poolSizeMode: 'automatic',
    manualPoolSize: null,
    qualifiersMode: 'automatic',
    membershipMode: 'snake',
  }
}

/**
 * PARSED, not cast (`.claude/rules/parse-at-boundaries.md`): the modes drive what the tab
 * renders and what the next save puts on the wire, so a payload holding a mode this client
 * does not know — or a manual `0` the server could never have stored — must fail here,
 * inside the fetch, rather than surface as an empty box three components away.
 *
 * **Absent and `null` are the same thing**: no structure. Only an `rr-then-ko` event has
 * one at all, the other three arms send `null`, and a fixture or stub that omits the key
 * means exactly what a `null` does.
 */
export function apiToDrawOwnership(
  structure: ApiDrawStructure | null | undefined,
): DrawOwnership | null {
  if (structure == null) return null
  return drawOwnershipSchema.parse({
    poolCountMode: structure.pool_count_mode,
    manualPoolCount: structure.manual_pool_count ?? null,
    poolSizeMode: structure.pool_size_mode,
    manualPoolSize: structure.manual_pool_size ?? null,
    qualifiersMode: structure.qualifiers_mode,
    membershipMode: structure.membership_mode,
  })
}

/**
 * The record as the `rr-then-ko` write arm takes it.
 *
 * **An event with no stored record sends the all-automatic one**, rather than omitting the
 * key: the editor sends what it rendered, and what it rendered for a structure-less event
 * is every setting the system's. (The server would default an omitted key to the same
 * thing — `default_factory=DrawStructure` — so this is the honest form of the same
 * request, not a different one.)
 */
export function drawOwnershipToApi(ownership: DrawOwnership | null): ApiDrawStructure {
  const stated = ownership ?? everySettingAutomatic()
  return {
    pool_count_mode: stated.poolCountMode,
    manual_pool_count: stated.manualPoolCount,
    pool_size_mode: stated.poolSizeMode,
    manual_pool_size: stated.manualPoolSize,
    qualifiers_mode: stated.qualifiersMode,
    membership_mode: stated.membershipMode,
  }
}

/**
 * Read what a director typed into a manual box — **the keystroke boundary**, and the
 * reason nothing downstream has to defend against a `0`.
 *
 * Three answers, because there are three things a keystroke can mean:
 *
 * - `null` — the box is **empty**. A real answer ("I have not set this"), never a zero:
 *   `Number('')` is `0`, and a `0` is both a 422 and a draw of no pools.
 * - a number — a value the server's bounds admit, ready to store.
 * - `undefined` — **not a value this box may hold**, so the keystroke is ignored and the
 *   box keeps the number the director last chose. It is not clamped to the bound: ADR
 *   20260808 is that the system never silently changes a director's number, and turning a
 *   pasted `600` into `512` would be exactly that edit.
 */
export function acceptedManualEntry(
  raw: string,
  max: number,
): number | null | undefined {
  const typed = raw.trim()
  if (typed === '') return null
  // Digits only, asked before the schema: it is what refuses `-1`, `3.5` and `1e3` as the
  // *characters* they are, rather than as numbers a `z.number().int()` would have to
  // reason about — and `z.number()` accepts `NaN` under the ESM build this app runs
  // (measured, Zod 4.4.3; see `entryFeeSchema`), so `Number('abc')` must never reach it.
  if (!/^\d+$/.test(typed)) return undefined
  const bounded = z.number().int().min(MANUAL_MIN).max(max).safeParse(Number(typed))
  return bounded.success ? bounded.data : undefined
}
