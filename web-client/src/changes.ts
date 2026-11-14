// The one announcement of what changed in this device's storage, to this tab
// and every other tab of the origin. Only src/storage.ts announces, after a
// write transaction completes, so no writer can forget; the stores in
// src/stores/ listen, and each reloads from IndexedDB what a mounted page is
// watching. This module reads and writes no data.

export type Change = {
  // This device's user, or the pointer to it, changed.
  account: boolean
  // The match ids (hex) the write touched; 'all' when it can't say. No match
  // is kept yet, so storage announces none.
  matches: string[] | 'all'
  // Storage's change counter after the write. Storage has none yet: 0.
  revision: number
}

// The BroadcastChannel every tab of the origin posts to and listens on.
export const changesChannel = 'fortymm-changes'

// What a tab is told when it may have missed messages: everything changed.
export const everything: Change = { account: true, matches: 'all', revision: 0 }

type Listener = (change: Change) => void

const listeners = new Set<Listener>()
let channel: BroadcastChannel | null | undefined

// Tells this tab's listeners, then the other tabs. The browser doesn't hand a
// message back to the channel that posted it, so this tab's listeners are
// called here, once. Never throws: a listener that throws, or a channel that
// can't post, stops no other listener and fails no write.
export function announce(change: Change): void {
  tell(change)
  try {
    openChannel()?.postMessage(change)
  } catch {
    // The other tabs catch up when they are next shown (below).
  }
}

// Calls listener with every change announced from now on, in this tab or
// another; and with everything when this page is shown again (back in view,
// or restored from the back/forward cache), since a hidden or frozen page can
// miss messages. Gives the function that stops it.
export function onChange(listener: Listener): () => void {
  openChannel()
  listenToPage()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function tell(change: Change) {
  for (const listener of [...listeners]) {
    try {
      listener(change)
    } catch {
      // One listener's failure is its own.
    }
  }
}

function openChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  if (typeof BroadcastChannel === 'undefined') {
    channel = null
    return channel
  }
  channel = new BroadcastChannel(changesChannel)
  channel.onmessage = (event: MessageEvent<Change>) => tell(event.data)
  return channel
}

let listeningToPage = false

function listenToPage() {
  if (listeningToPage || typeof document === 'undefined') return
  listeningToPage = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tell(everything)
  })
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) tell(everything)
  })
}
