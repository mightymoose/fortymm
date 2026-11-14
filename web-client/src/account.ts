import { startupLaunchSettled } from './first-launch.ts'
import { loadMe, type LoadUserResult, type User } from './storage.ts'

// This device's account, as stored on the device (src/storage.ts), for
// /settings to show.
export type Account =
  | { state: 'user'; user: User }
  | { state: 'none' }
  | { state: 'storage-unavailable' }

// Reads this device's user with loadMe, one read: no key, no core. On a device
// whose first launch is still running (a first visit straight to /settings),
// no user is marked yet: it then waits for that launch, up to its bound
// (startupLaunchSettled), and reads again. It reads only: with no user, the
// answer is that there is no account yet, and nothing is made. Every outcome
// is an answer; it never throws.
export async function ownAccount(): Promise<Account> {
  const first = await loadMe()
  if (first.ok && first.user === null) {
    await startupLaunchSettled()
    return accountOf(await loadMe())
  }
  return accountOf(first)
}

function accountOf(loaded: LoadUserResult): Account {
  if (!loaded.ok) return { state: 'storage-unavailable' }
  return loaded.user === null ? { state: 'none' } : { state: 'user', user: loaded.user }
}
