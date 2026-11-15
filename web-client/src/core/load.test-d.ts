// Type-level tests, checked by `tsc -b` (web-client:typecheck). Nothing here
// runs or ships: no module imports this file.
//
// They prove the web client's types for the core are the core's own
// fortymm-core.d.mts, written beside the wrapper by core:wasm. Each marked line
// must be a type error; if the types were lost (the wrapper typed as `any`),
// the expect-error directive would be unused and tsc would fail.
import type { Kind, MatchState } from 'fortymm-core/fortymm-core.mjs'
import { expectTypeOf } from 'vitest'
import { loadCore } from './load.ts'

export async function callsTheCoreAsItsTypesSay() {
  const core = await loadCore()
  expectTypeOf(core.username(new Uint8Array(32), 4)).toEqualTypeOf<string>()
  expectTypeOf(core.matchId(new Uint8Array())).toEqualTypeOf<Uint8Array | null>()
  expectTypeOf(
    core.helloBody(2, new Uint8Array(33), new Uint8Array(8), Date.now()),
  ).toEqualTypeOf<Uint8Array>()
  expectTypeOf(core.assemble(new Uint8Array(), new Uint8Array(64))).toEqualTypeOf<Uint8Array>()
}

// Making a `player`, a `match` and a `score`, and reading a score.
export async function makesAndReadsTheMatchKindsAsTheCoresTypesSay() {
  const core = await loadCore()
  const key = new Uint8Array(33)
  const random = new Uint8Array(8)
  const id = new Uint8Array(32)
  expectTypeOf(core.playerBody(2, key, random, Date.now())).toEqualTypeOf<Uint8Array>()
  expectTypeOf(
    core.matchBody(2, key, random, [[id], [id, id]], new Uint8Array(), Date.now()),
  ).toEqualTypeOf<Uint8Array>()
  expectTypeOf(
    core.scoreBody(2, key, random, id, 1, new Uint8Array(), [id], Date.now()),
  ).toEqualTypeOf<Uint8Array>()
  expectTypeOf(core.kind(new Uint8Array())).toEqualTypeOf<Kind | null>()
  expectTypeOf<'player' | 'match' | 'score'>().toExtend<Kind>()
  expectTypeOf(core.scoredMatch(new Uint8Array())).toEqualTypeOf<Uint8Array | null>()
  expectTypeOf(core.slot(new Uint8Array())).toEqualTypeOf<number | null>()
  expectTypeOf(core.value(new Uint8Array())).toEqualTypeOf<Uint8Array | null>()
  expectTypeOf(core.replaces(new Uint8Array())).toEqualTypeOf<Uint8Array[] | null>()
}

export async function makesTheMatchKindsWithWrongArguments() {
  const core = await loadCore()
  const key = new Uint8Array(33)
  const random = new Uint8Array(8)
  const id = new Uint8Array(32)
  // @ts-expect-error: the random value is required
  core.playerBody(2, key)
  // @ts-expect-error: a match has two sides, not one
  core.matchBody(2, key, random, [[id]], new Uint8Array())
  // @ts-expect-error: a side is a list of player ids, not one id
  core.matchBody(2, key, random, [id, id], new Uint8Array())
  // @ts-expect-error: the terms are required
  core.matchBody(2, key, random, [[id], [id]])
  // @ts-expect-error: the slot is a number
  core.scoreBody(2, key, random, id, '1', new Uint8Array(), [])
  // @ts-expect-error: the replaced ids are required
  core.scoreBody(2, key, random, id, 1, new Uint8Array())
  // @ts-expect-error: a kind is one of the names, not any string
  const kind: Kind = 'no-such-kind'
  return kind
}

export async function callsTheCoreWithWrongArguments() {
  const core = await loadCore()
  // @ts-expect-error: a player id is bytes, not a hex string
  core.username('e2286f7c', 4)
  // @ts-expect-error: the suffix length is a number
  core.username(new Uint8Array(32), '4')
  // @ts-expect-error: the wrapper has no such method
  core.noSuchMethod()
  // @ts-expect-error: the environment is a number
  core.helloBody('uat', new Uint8Array(33), new Uint8Array(8))
  // @ts-expect-error: the key is bytes, not a hex string
  core.helloBody(2, '0217e6', new Uint8Array(8))
  // @ts-expect-error: the random value is required
  core.helloBody(2, new Uint8Array(33))
  // @ts-expect-error: the clock is milliseconds, not a Date
  core.helloBody(2, new Uint8Array(33), new Uint8Array(8), new Date())
  // @ts-expect-error: assemble takes the signature as bytes
  core.assemble(new Uint8Array(), 'signature')
  // @ts-expect-error: assemble needs the signature
  core.assemble(new Uint8Array())
}

// A match's state from its records (core/FORMAT.md, section 16).
export async function derivesAMatchsStateAsTheCoresTypesSay() {
  const core = await loadCore()
  const state = core.matchState([new Uint8Array()])
  expectTypeOf(state).toEqualTypeOf<MatchState | null>()
  if (state === null) return
  expectTypeOf(state.matchId).toEqualTypeOf<Uint8Array>()
  expectTypeOf(state.creator).toEqualTypeOf<Uint8Array>()
  expectTypeOf(state.sides).toEqualTypeOf<[Uint8Array[], Uint8Array[]]>()
  expectTypeOf(state.terms).toEqualTypeOf<{ bestOf: number; rated: boolean } | null>()
  expectTypeOf(state.games).toEqualTypeOf<([number, number] | null)[]>()
  expectTypeOf(state.current).toEqualTypeOf<Uint8Array[][]>()
  // @ts-expect-error: the records are a list of byte strings, not one record
  core.matchState(new Uint8Array())
}
