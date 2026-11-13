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
  expectTypeOf(
    core.helloBody(2, new Uint8Array(33), new Uint8Array(8), Date.now()),
  ).toEqualTypeOf<Uint8Array>()
  expectTypeOf(core.assemble(new Uint8Array(), new Uint8Array(64))).toEqualTypeOf<Uint8Array>()
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
