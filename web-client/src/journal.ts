import type { Core } from 'fortymm-core/fortymm-core.mjs'
import { loadCore } from './core/load.ts'
import { storedSignature, withDeviceKey, type DeviceKeyFailure } from './device-key.ts'
import { environment } from './first-launch.ts'
import type { AppendFailure, Store } from './storage.ts'
import type { Refusal, Unavailable } from './stores/match-source.ts'

// The journal's one way to make records (design 4.3 and 5;
// PLAN-match-store-and-sync.md §2, task F): commit runs a draft, which
// decides what to make, then keeps what it made. Everything happens inside
// one withDeviceKey callback, so inside the append lock: the draft reads
// what is on disk at that moment (store.loadMatch), whatever any tab's
// memory says, and no other write, in this tab or another, comes between
// what it read and what it keeps.
//
// - The draft gets the core, this device's own player id, the held store
//   and make. make signs and assembles one record: it draws the random
//   value, hands it with the environment and the device's public key to the
//   draft's body builder, signs the body with the device key, and has the
//   core assemble the record, which verifies it (design 4.5, "commit
//   verifies its own output before storing it").
// - Only what make made in this commit is kept, in the order the draft
//   gives it: a record make didn't make (another key's, one kept already)
//   is record-refused. The draft's store only reads, so the draft keeps
//   nothing itself.
// - Nothing is kept unless every record of the draft is: a draft that
//   refuses, a make that fails (even one the draft caught) or an append that
//   fails keeps nothing. The append is one transaction.
// - No hello first: "any record it signs introduces it", and a hello is
//   "never required" (design section 4). commit makes none.
// - Failures are answers, never thrown. Only a draft's own code throwing (a
//   bug, such as a body builder given an id of the wrong length) makes
//   commit throw, with nothing kept and the lock released; a body builder
//   that throws does so even when the draft caught its error. After a
//   failed signature, the answer is signing-unavailable, whatever the draft
//   then threw or returned.
//
// Only what makes records calls it (feature code never signs: design 4.3):
// the match stores' device source (task G2).

// What a body builder gets from make, in the order the core's builders take
// them: core.playerBody(...signer), core.matchBody(...signer, sides, terms).
// The random value is 8 bytes from the platform's generator, never the
// draft's choice (design 4.3).
export type Signer = readonly [environment: number, publicKey: Uint8Array, random: Uint8Array]

// The held store's reads a draft may make: loadMatch, and nothing that
// writes. A draft that could append or storeRecord could keep records
// outside all or none, or change which user is this device's.
export type DraftStore = Pick<Store, 'loadMatch'>

export type DraftContext = {
  core: Core
  // This device's own player id: the key's.
  me: Uint8Array
  // What is on disk now, read through the held store (heldStore,
  // src/storage.ts). It only reads: what is kept is what the draft gives
  // back, and nothing else. Keep it no longer than the draft.
  store: DraftStore
  // Signs and assembles one record from the body the builder gives. Rejects
  // when the builder throws (with its error) or signing or assembling fails;
  // commit then keeps nothing, whatever the draft does next. The records it
  // gives are the only ones commit keeps.
  make(body: (signer: Signer) => Uint8Array): Promise<Uint8Array>
}

// What a draft decides: the records to keep, in order, and what commit then
// answers; or a refusal, answered as it is; or a read the store refused
// (store.loadMatch's answer), answered as it is.
export type Drafted<T> =
  | { records: Uint8Array[]; value: T }
  | { refused: Refusal }
  | Unavailable
export type Draft<T> = (context: DraftContext) => Promise<Drafted<T>>

// Why nothing was kept, besides a refusal.
// - signing-unavailable: no device key (device-key.ts), or signing or
//   assembling one of the draft's records failed.
// - storage-unavailable, locks-unavailable: from the device key, the
//   draft's read or the append.
// - core-unavailable: the shared core didn't load. No key is made.
// - record-refused: the draft gave a record make didn't make in this commit
//   (another key's, or one kept already), or one append doesn't keep (a
//   hello). A bug in the draft.
export type CommitFailure = DeviceKeyFailure | AppendFailure

export type CommitResult<T> =
  | { ok: true; value: T }
  | ({ ok: false } & ({ reason: CommitFailure } | Refusal))

// What make rejects with when signing or assembling fails, told apart from
// what the draft itself throws.
class SigningFailed extends Error {}

// How a make failed: its body builder threw (the draft's own code), or
// signing or assembling the body failed.
type MakeFailure = { builder: unknown } | { signing: true }

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function commit<T>(draft: Draft<T>): Promise<CommitResult<T>> {
  // Before the key: a core that doesn't load leaves no key made.
  let core: Core
  try {
    core = await loadCore()
  } catch {
    return { ok: false, reason: 'core-unavailable' }
  }
  const result = await withDeviceKey(async (key, store): Promise<CommitResult<T>> => {
    // The first make that failed, if one did. Nothing is kept after it,
    // whatever the draft does next, even if it caught the failure.
    let failed: MakeFailure | undefined
    // The ids (hex) of the records make made in this commit: the only
    // records commit keeps.
    const made = new Set<string>()
    const make = async (body: (signer: Signer) => Uint8Array) => {
      let bytes: Uint8Array
      try {
        bytes = body([environment, key.publicKey, crypto.getRandomValues(new Uint8Array(8))])
      } catch (error) {
        failed ??= { builder: error }
        throw error
      }
      try {
        const record = core.assemble(bytes, storedSignature(core, await key.sign(bytes)))
        made.add(hex(core.id(record)))
        return record
      } catch {
        failed ??= { signing: true }
        throw new SigningFailed()
      }
    }
    // A failed make's answer: a builder's error is the draft's own code
    // throwing, so commit throws it; a signature or an assembly that failed
    // is signing-unavailable.
    const afterFailedMake = (failure: MakeFailure): CommitResult<T> => {
      if ('builder' in failure) throw failure.builder
      return { ok: false, reason: 'signing-unavailable' }
    }

    let drafted: Drafted<T>
    try {
      const reads: DraftStore = { loadMatch: (matchId) => store.loadMatch(matchId) }
      drafted = await draft({ core, me: core.ownPlayerId(key.publicKey), store: reads, make })
    } catch (error) {
      if (failed !== undefined) return afterFailedMake(failed)
      throw error
    }
    if (failed !== undefined) return afterFailedMake(failed)
    if ('refused' in drafted) return { ok: false, ...drafted.refused }
    if ('ok' in drafted) return drafted
    if (!drafted.records.every((record) => made.has(hex(core.id(record))))) {
      return { ok: false, reason: 'record-refused' }
    }
    const appended = await store.append(drafted.records)
    return appended.ok ? { ok: true, value: drafted.value } : appended
  })
  return result.ok ? result.value : result
}
