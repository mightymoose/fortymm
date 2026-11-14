import { createStore, useStore } from 'zustand'
import { onChange, type Change } from '../changes.ts'
import { launchAtStartup, startupLaunchSettled } from '../first-launch.ts'
import { loadMe, type LoadUserResult, type User } from '../storage.ts'
import { createQueue } from './queue.ts'

// This device's user, in memory, for whatever shows it (/settings, and the
// layout). It holds nothing that isn't on disk: every value was read from
// IndexedDB with loadMe (src/storage.ts), after the write that produced it
// finished. No action sets the user itself: the first launch writes, storage
// announces the change (src/changes.ts), and the store reads again.
//
// It is always on: every page shows the user, so every change to this
// device's account is read again, with no watcher to ask. The match stores
// of the plan are not like this: they read again only what a page watches.

// This device's account, as stored on the device.
// - user: this device's user.
// - none: no first launch yet, or it failed.
// - storage-unavailable: the browser refused to read the storage.
export type Account =
  | { state: 'user'; user: User }
  | { state: 'none' }
  | { state: 'storage-unavailable' }

// unread: not read yet (before the first load or launch).
export type UserState = { state: 'unread' } | Account

export type UserStore = {
  user: UserState
  // For loaders: resolves once the user has been read. One read; with no
  // user while the launch at startup is running, it waits for that launch,
  // up to its bound (startupLaunchSettled), and reads again. It makes
  // nothing, and never rejects.
  load(): Promise<void>
  // main.tsx, after the first paint: one read of the user, then the first
  // launch (launchAtStartup, src/first-launch.ts), then a read again. Never
  // rejects.
  launch(): Promise<void>
}

// A store of its own, listening for changes from now on. The app has one,
// userStore; a test builds a fresh one.
export function createUserStore() {
  const queue = createQueue()

  // Reads the user once and puts it in the store, on the queue. What the
  // store had stays until the new read lands, so nothing flashes.
  const reload = () =>
    queue(async () => {
      store.setState({ user: accountOf(await loadMe()) })
    })

  const store = createStore<UserStore>()((set) => ({
    user: { state: 'unread' },
    load: () =>
      queue(async () => {
        let loaded = await loadMe()
        if (loaded.ok && loaded.user === null) {
          await startupLaunchSettled()
          loaded = await loadMe()
        }
        set({ user: accountOf(loaded) })
      }),
    launch: async () => {
      // Read first: a device that already has its user shows it at once,
      // on every page, without waiting for the launch (which waits for the
      // core's module). Then read again once the launch has settled.
      void reload()
      await launchAtStartup()
      await reload()
    },
  }))

  onChange((change: Change) => {
    if (change.account) void reload()
  })
  return store
}

export const userStore = createUserStore()

// This device's user, for a connected component (src/components/Settings.tsx).
export function useUser(): UserState {
  return useStore(userStore, (store) => store.user)
}

function accountOf(loaded: LoadUserResult): Account {
  if (!loaded.ok) return { state: 'storage-unavailable' }
  return loaded.user === null ? { state: 'none' } : { state: 'user', user: loaded.user }
}
