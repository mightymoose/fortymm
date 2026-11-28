import { deviceKey } from './device-key.ts'
import { persistStorage } from './persist-storage.ts'

// What every page load does for the device, whatever the route: make sure this device has its
// signing key (J6), and ask the browser to keep the site's storage. main.tsx starts it once React
// has been asked to render, and nothing on screen waits for it. A step that fails leaves things as
// they were, and the next page load tries again.
//
// Each step sets a User Timing mark once it settles, with its outcome as the mark's detail, so
// tests (and the performance panel) can see what happened: deviceKeyMark has a DeviceKeyResult
// without the keys, persistStorageMark a PersistStorageOutcome.
export const deviceKeyMark = 'fortymm:device-key'
export const persistStorageMark = 'fortymm:persist-storage'

// Never rejects.
export async function land(): Promise<void> {
  await Promise.all([
    deviceKey().then((result) => {
      const detail = result.ok
        ? { ok: true, outcome: result.outcome }
        : { ok: false, reason: result.reason }
      performance.mark(deviceKeyMark, { detail })
    }),
    persistStorage().then((outcome) => {
      performance.mark(persistStorageMark, { detail: outcome })
    }),
  ])
}
