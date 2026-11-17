// Type-level tests, checked by `tsc -b` (web-client:typecheck). Nothing here
// runs or ships: no module imports this file.
//
// They prove a draft's store only reads. Each marked line must be a type
// error; if the draft were given the whole held store, the expect-error
// directive would be unused and tsc would fail. That the store has nothing
// else at runtime either is in journal.test.ts.
import type { DraftContext } from './journal.ts'

export async function draftReads({ store }: DraftContext) {
  await store.loadMatch('00'.repeat(32))
}

export async function draftWrites({ store }: DraftContext) {
  // @ts-expect-error: a draft's store has no append
  await store.append([])
  // @ts-expect-error: a draft's store has no storeRecord
  await store.storeRecord(new Uint8Array(0), { me: true })
  // @ts-expect-error: a draft's store has no loadUser (no draft needs it)
  await store.loadUser('00'.repeat(32))
}
