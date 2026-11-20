import { loadMatches } from './storage.ts'

// Asking the browser to keep this device's data (black-box #2, approved
// 2026-11-18). Unless asked, a browser may delete a site's storage when
// space runs low (Chrome), or after days without a visit (Safari), and with
// it every match and the device key. `navigator.storage.persist()` asks it
// not to; the browser decides (Chrome grants it to an installed or much
// used site), and `persisted()` says whether it is so.
//
// - afterKept: right after a record is kept (the device source, after Start
//   match's commit), never on a load of an empty device.
// - onStart: at app start, a device that has matches and isn't protected
//   asks again, quietly.
// At most once per page. Never blocks, never shows anything, never throws:
// without the API it does nothing, and a refusal changes nothing.

// What it uses of the browser's StorageManager.
export type PersistentStorage = Partial<Pick<StorageManager, 'persist' | 'persisted'>>

export function createKeeping({
  storage,
  hasMatches,
}: {
  storage: () => PersistentStorage | undefined
  hasMatches: () => Promise<boolean>
}) {
  let asked = false

  async function ask() {
    if (asked) return
    const manager = storage()
    if (manager?.persist === undefined || manager.persisted === undefined) return
    asked = true
    try {
      if (await manager.persisted()) return
      await manager.persist()
    } catch {
      // The browser said no, or couldn't say: nothing changes.
    }
  }

  return {
    afterKept: () => ask(),
    async onStart() {
      let has: boolean
      try {
        has = await hasMatches()
      } catch {
        return
      }
      if (has) await ask()
    },
  }
}

// The app's: the browser's storage manager, and the matches kept here.
export const keeping = createKeeping({
  storage: () => (typeof navigator === 'undefined' ? undefined : navigator.storage),
  hasMatches: async () => {
    const read = await loadMatches()
    return read.ok && read.matches.length > 0
  },
})
