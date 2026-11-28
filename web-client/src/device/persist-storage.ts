// Asks the browser to keep the site's storage, the device key and (later) the journal with it,
// rather than evicting it under storage pressure or after a period without use (design 5.4,
// "Web storage can be deleted"). It lowers the risk; it cannot prevent the loss: the user can
// still clear site data, and a private window still discards it.
//
// Browsers decide differently: Chromium grants or refuses without asking (by site engagement, an
// installed app, a bookmark), Firefox asks the user, and Safari grants it to a web app on the home
// screen. A refusal is not an error: the app works as before, and the next start asks again.

// - already-persisted: the storage was persistent before this call; nothing was asked.
// - persisted: this call asked, and the browser granted it.
// - refused: this call asked, and the browser (or the user) said no.
// - unavailable: this browser has no StorageManager persistence, or it failed.
export type PersistStorageOutcome = 'already-persisted' | 'persisted' | 'refused' | 'unavailable'

// Never throws.
export async function persistStorage(): Promise<PersistStorageOutcome> {
  const storage = globalThis.navigator?.storage
  if (storage?.persisted === undefined || storage.persist === undefined) return 'unavailable'
  try {
    if (await storage.persisted()) return 'already-persisted'
    return (await storage.persist()) ? 'persisted' : 'refused'
  } catch {
    return 'unavailable'
  }
}
