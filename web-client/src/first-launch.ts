import type { Core } from 'fortymm-core/fortymm-core.mjs'
import { loadCore } from './core/load.ts'
import { storedSignature, withDeviceKey, type DeviceKeyFailure } from './device-key.ts'
import type { StoreFailure } from './storage.ts'

// The first launch on a device (design 4.3, 4.4 and 5.4): the device's key
// is made, and the device makes and signs its own hello and stores it, with
// the user it mints. Every later launch finds that user and does nothing.
// Nothing syncs yet: the stored hello waits for sync.
//
// It runs at every app start (main.tsx), after the app has rendered, and
// the app never waits for it. A launch that fails leaves no user (/settings
// then says there is no account yet), and the next start tries again.

// The environment number in every record this app makes (core/FORMAT.md,
// section 4): 3, development, "a developer's own stack". A placeholder until
// real environments exist: today the app runs only on developers' stacks and
// on ephemeral previews, and nothing checks the number yet (refusing a record
// from the wrong environment is the server's job, design 6.2). Production
// and UAT builds will each need their own.
export const environment = 3

// - made: this launch stored the device's hello and its user.
// - kept: a user was already stored for this device's key; nothing changed.
export type FirstLaunchResult =
  | { ok: true; outcome: 'made' | 'kept' }
  | {
      ok: false
      reason: DeviceKeyFailure | StoreFailure
    }

// The name of the User Timing mark the app sets once the launch at startup
// has settled, with its FirstLaunchResult as the mark's detail.
export const firstLaunchMark = 'fortymm:first-launch'

// Makes and stores this device's hello if no user is stored for its key. A
// key kept with no user (a launch that stopped between steps) gets its hello
// now, from the same key. Never throws.
export async function firstLaunch(): Promise<FirstLaunchResult> {
  let core: Core
  try {
    core = await loadCore()
  } catch {
    return { ok: false, reason: 'core-unavailable' }
  }
  try {
    const result = await withDeviceKey(async (key, store): Promise<FirstLaunchResult> => {
      const kept = await store.loadUser(hex(core.ownPlayerId(key.publicKey)))
      if (!kept.ok) return kept
      if (kept.user !== null) return { ok: true, outcome: 'kept' }

      const random = crypto.getRandomValues(new Uint8Array(8))
      const body = core.helloBody(environment, key.publicKey, random)
      const hello = core.assemble(body, storedSignature(core, await key.sign(body)))
      const stored = await store.storeRecord(hello)
      return stored.ok ? { ok: true, outcome: 'made' } : stored
    })
    return result.ok ? result.value : result
  } catch {
    // Signing or assembling threw: no hello was stored.
    return { ok: false, reason: 'signing-unavailable' }
  }
}

// The launch at app startup: runs firstLaunch, then sets firstLaunchMark.
export async function launchAtStartup(): Promise<void> {
  const result = await firstLaunch()
  performance.mark(firstLaunchMark, { detail: result })
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
