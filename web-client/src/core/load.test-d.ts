// Type-level tests, checked by `tsc -b` (web-client:typecheck). Nothing here
// runs or ships: no module imports this file.
//
// They prove the web client's types for the core are the core's own
// fortymm-core.d.mts, written beside the wrapper by core:wasm. Each marked line
// must be a type error; if the types were lost (the wrapper typed as `any`),
// the expect-error directive would be unused and tsc would fail.
import { expectTypeOf } from 'vitest'
import { loadCore } from './load.ts'

export async function callsTheCoreAsItsTypesSay() {
  const core = await loadCore()
  expectTypeOf(core.username(new Uint8Array(32), 4)).toEqualTypeOf<string>()
  expectTypeOf(core.matchId(new Uint8Array())).toEqualTypeOf<Uint8Array | null>()
}

export async function callsTheCoreWithWrongArguments() {
  const core = await loadCore()
  // @ts-expect-error: a player id is bytes, not a hex string
  core.username('e2286f7c', 4)
  // @ts-expect-error: the suffix length is a number
  core.username(new Uint8Array(32), '4')
  // @ts-expect-error: the wrapper has no such method
  core.noSuchMethod()
}
