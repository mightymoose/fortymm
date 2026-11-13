import type { Core } from 'fortymm-core/fortymm-core.mjs'
import { loadCore } from './core/load.ts'
import { storedSignature, withDeviceKey, type DeviceKeyFailure } from './device-key.ts'
import type { StoreFailure, StoreMeResult } from './storage.ts'

// The first launch on a device (design 4.3, 4.4 and 5.4): the device's key
// is made, and the device makes and signs its own hello and stores it, with
// the user it mints. Every later launch finds that user and does nothing.
// Nothing syncs yet: the stored hello waits for sync.
//
// It starts at every app start (main.tsx), in the background, without
// delaying the first paint: main.tsx asks React to render first, and nothing
// on screen waits for the launch (its core fetch may begin before the page
// has content). A launch that fails leaves no user (/settings
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
      reason: DeviceKeyFailure | StoreFailure | Extract<StoreMeResult, { ok: false }>['reason']
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
  const result = await withDeviceKey(async (key, store): Promise<FirstLaunchResult> => {
    const own = hex(core.ownPlayerId(key.publicKey))
    const kept = await store.loadUser(own)
    if (!kept.ok) return kept
    if (kept.user !== null) {
      // A user stored before the me pointer existed gets it now; otherwise
      // this writes nothing.
      const pointed = await store.storeMe(own)
      return pointed.ok ? { ok: true, outcome: 'kept' } : pointed
    }

    let hello: Uint8Array
    try {
      const random = crypto.getRandomValues(new Uint8Array(8))
      const body = core.helloBody(environment, key.publicKey, random)
      hello = core.assemble(body, storedSignature(core, await key.sign(body)))
    } catch {
      // Signing or assembling threw: no hello to store.
      return { ok: false, reason: 'signing-unavailable' }
    }
    const stored = await store.storeRecord(hello, { me: true })
    return stored.ok ? { ok: true, outcome: 'made' } : stored
  })
  return result.ok ? result.value : result
}

// How long a screen waits for the launch at startup before reading without
// it (startupLaunchSettled). A launch on a fresh device takes well under a
// second (the core's module, a key, a signature, one write); five seconds
// covers a slow connection fetching the core, and bounds a launch held back
// by another tab keeping the append lock.
export const startupLaunchBound = 5_000

let atStartup: Promise<void> | undefined

// The launch at app startup: runs firstLaunch, then sets firstLaunchMark.
export function launchAtStartup(): Promise<void> {
  atStartup = firstLaunch().then((result) => {
    performance.mark(firstLaunchMark, { detail: result })
  })
  return atStartup
}

// Resolves once the launch at startup has settled, or after bound
// milliseconds, whichever comes first; at once when none was started. Never
// rejects, and never starts a launch: a screen that finds no account yet
// waits here, then reads again.
export function startupLaunchSettled(bound = startupLaunchBound): Promise<void> {
  if (atStartup === undefined) return Promise.resolve()
  return Promise.race([
    atStartup.catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, bound)),
  ])
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
