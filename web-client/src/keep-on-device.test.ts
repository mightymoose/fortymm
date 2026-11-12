import { afterEach, expect, test, vi } from 'vitest'
import { keepAppOnDevice } from './keep-on-device.ts'

// jsdom has no service workers: stand in for navigator.serviceWorker and
// record the workers the app asks for.
function serviceWorkers() {
  const registered: string[] = []
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: async (url: string) => {
        registered.push(url)
      },
    },
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
