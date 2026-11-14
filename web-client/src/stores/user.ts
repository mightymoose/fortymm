import { createStore, useStore } from 'zustand'
import { onChange, type Change } from '../changes.ts'
import { launchAtStartup, startupLaunchSettled } from '../first-launch.ts'
import { loadMe, type LoadUserResult, type User } from '../storage.ts'
import { createQueue } from './queue.ts'

// This device's user, in memory, for the pages that show it (/settings). It
// holds nothing that isn't on disk: every value was read from IndexedDB with
// loadMe (src/storage.ts), after the write that produced it finished. No
// action sets the user itself: the first launch writes, storage announces
// the change (src/changes.ts), and the store reads again.

// This device's account, as stored on the device.
// - user: this device's user.
// - none: no first launch yet, or it failed.
// - storage-unavailable: the browser refused to read the storage.
export type Account =
  | { state: 'user'; user: User }
  | { state: 'none' }
  | { state: 'storage-unavailable' }

// unread: not read since it last changed, and no page is showing it.
export type UserState = { state: 'unread' } | Account

export type UserStore = {
  user: UserState
  // For loaders: resolves once the user has been read. One read; with no
  // user while the launch at startup is running, it waits for that launch,
  // up to its bound (startupLaunchSettled), and reads again. It makes
  // nothing, and never rejects.
  load(): Promise<void>
  // A mounted page is showing the user: while watched, every change to this
  // device's account is read again. Gives the function that stops watching.
  watchUser(): () => void
  // main.tsx, after the first paint: the first launch (launchAtStartup,
  // src/first-launch.ts), then a reload. Never rejects.
  launch(): Promise<void>
}

// A store of its own, listening for changes from now on. The app has one,
// userStore; a test builds a fresh one.
export function createUserStore() {
  const queue = createQueue()
  let watchers = 0

  // Reads the user once and puts it in the store, on the queue.
  const reload = () =>
    queue(async () => {
      store.setState({ user: accountOf(await loadMe()) })
    })

  // After a change: read again what a page shows; forget what none does.
  const refresh = () =>
    watchers > 0
      ? reload()
      : queue(async () => store.setState({ user: { state: 'unread' } }))

  const store = createStore<UserStore>()((set, get) => {
    return {
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
      watchUser: () => {
        watchers += 1
        // Forgotten while no page watched it: read it for this one.
        if (get().user.state === 'unread') void reload()
        let watching = true
        return () => {
          if (watching) watchers -= 1
          watching = false
        }
      },
      launch: async () => {
        await launchAtStartup()
        await refresh()
      },
    }
  })

  onChange((change: Change) => {
    if (change.account) void refresh()
  })
  return store
}

export const userStore = createUserStore()

// This device's user, for a connected component (src/components/Settings.tsx).
export function useUser(): UserState {
  return useStore(userStore, (store) => store.user)
}

export function watchUser(): () => void {
  return userStore.getState().watchUser()
}

function accountOf(loaded: LoadUserResult): Account {
  if (!loaded.ok) return { state: 'storage-unavailable' }
  return loaded.user === null ? { state: 'none' } : { state: 'user', user: loaded.user }
}
