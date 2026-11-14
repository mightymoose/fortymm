import { afterEach, expect, test, vi } from 'vitest'
import { keepAppOnDevice } from './keep-on-device.ts'
import { showNewVersionOf } from './new-version.ts'

vi.mock('./new-version.ts', async (original) => ({
  ...(await original<typeof import('./new-version.ts')>()),
  showNewVersionOf: vi.fn(),
}))

// jsdom has no service workers: stand in for navigator.serviceWorker and
// record the workers the app asks for. The registration has a new version
// waiting, as a page loaded after a deployment finds it.
function serviceWorkers() {
  const registered: string[] = []
  const container = Object.assign(new EventTarget(), {
    controller: Object.assign(new EventTarget(), { state: 'activated' }),
    register: async (url: string) => {
      registered.push(url)
      return Object.assign(new EventTarget(), {
        installing: null,
        waiting: Object.assign(new EventTarget(), { state: 'installed' }),
        update: async () => {},
      })
    },
  })
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  })
  return registered
}

afterEach(() => {
  vi.unstubAllEnvs()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

test('a development build (the dev server) registers no service worker', () => {
  vi.stubEnv('PROD', false)
  const registered = serviceWorkers()

  keepAppOnDevice()
  window.dispatchEvent(new Event('load'))

  expect(registered).toEqual([])
})

test('a production build registers /sw.js once the page has loaded', () => {
  vi.stubEnv('PROD', true)
  const registered = serviceWorkers()

  keepAppOnDevice()
  expect(registered).toEqual([])
  window.dispatchEvent(new Event('load'))

  expect(registered).toEqual(['/sw.js'])
})

test('once registered, the app shows whether its registration has a new version ready', async () => {
  vi.stubEnv('PROD', true)
  serviceWorkers()

  keepAppOnDevice()
  window.dispatchEvent(new Event('load'))

  await vi.waitFor(() => expect(showNewVersionOf).toHaveBeenCalledOnce())
  const [newVersion] = vi.mocked(showNewVersionOf).mock.calls[0]!
  expect(newVersion.ready()).toBe(true)
})
